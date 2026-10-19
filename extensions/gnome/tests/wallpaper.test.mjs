// Run with: node --test extensions/gnome/tests/wallpaper.test.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class Actor {
    handlers = new Map();
    children = new Set();
    nextId = 1;
    disposed = false;
    constructor(...args) { this._init(...args); }
    _init(props) { Object.assign(this, props); }
    connect(name, callback) {
        assert.ok(!this.disposed);
        const id = this.nextId++;
        this.handlers.set(id, {name, callback});
        return id;
    }
    disconnect(id) { assert.ok(this.handlers.delete(id)); }
    add_child(child) { this.children.add(child); child.parent = this; }
    set_style() {}
    ease(props) { assert.ok(!this.disposed); this.opacity = props.opacity; }
    remove_all_transitions() { assert.ok(!this.disposed); }
    destroy() {
        assert.ok(!this.disposed, 'actor destroyed twice');
        this.destroying = true;
        for (const [id, handler] of [...this.handlers]) {
            if (this.handlers.has(id) && handler.name === 'destroy')
                handler.callback(this);
        }
        // A class closure override replaces Clutter's default child destruction.
        if (this.on_destroy)
            this.on_destroy();
        else
            for (const child of [...this.children]) child.destroy();
        this.parent?.children.delete(this);
        this.handlers.clear();
        this.disposed = true;
    }
}

function setup() {
    const windows = [];
    const actors = new Set();
    let monitors = [{connector: 'DP-1', geometry: {x: 0, y: 0, width: 1920, height: 1080}}];
    const source = readFileSync(new URL('../extension/wallpaper.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace(/^export /gm, '');
    const Wallpaper = vm.runInNewContext(`${source}\n({LiveWallpaper, WallpaperRole, APPLICATION_ID, findRendererForMonitor})`, {
        St: {Widget: Actor}, GObject: {registerClass: klass => klass},
        Clutter: {Clone: Actor, FixedLayout: class {}, BinLayout: class {}, AnimationMode: {}},
        BlurController: class { setState() {} destroy() {} },
        PauseEffectKind: {BLUR: 'blur'},
        global: {
            backend: {get_monitor_manager: () => ({get_monitor_for_connector:
                connector => monitors.findIndex(m => m.connector === connector)})},
            display: {list_all_windows: () => windows.filter(w => !w.disposed).map(w => w.meta_window),
                get_n_monitors: () => monitors.length,
                get_monitor_geometry: index => monitors[index].geometry}},
    });
    function renderer(connector = 'DP-1', geometry = monitors[0].geometry) {
        const hints = JSON.stringify({presentationReady: true, connector, geometry});
        const actor = new Actor({meta_window: {
            title: `@${Wallpaper.APPLICATION_ID}!${hints}`,
            get_monitor: () => 0,
        }});
        actor.meta_window.get_compositor_private = () => actor;
        windows.push(actor);
        return {actor, launcher: {ownsWindow: window => window === actor.meta_window}};
    }
    function wallpaper(launcher, available = true, role = Wallpaper.WallpaperRole.Desktop) {
        const background = new Actor({monitor: 0});
        const content = {brightness: 0.5, vignette: false};
        Object.defineProperty(background, 'content', {get() {
            assert.ok(!background.destroying && !background.disposed, 'read disposing background');
            return content;
        }});
        const actor = new Wallpaper.LiveWallpaper(background, role, available, launcher,
            destroyed => actors.delete(destroyed));
        actors.add(actor);
        return {actor, background, content};
    }
    return {renderer, wallpaper, actors, Wallpaper, windows,
        setMonitors(next) { monitors = next; }, flush() {
        for (const actor of actors)
            actor.syncRenderer();
    }};
}

test('parent destruction unregisters wallpaper and preserves default child destruction', () => {
    const s = setup();
    const r = s.renderer();
    const {actor, background} = s.wallpaper(r.launcher);
    const clone = actor._cloneActor;
    const extraChild = new Actor();
    actor.add_child(extraChild);
    background.destroy();
    assert.equal(s.actors.size, 0);
    assert.ok(actor.disposed && clone.disposed && extraChild.disposed);
    assert.equal(r.actor.handlers.size, 0);
    actor.setRendererAvailable(true);
    actor.setRendererLauncher(null);
    actor.setPresentation(null);
    r.actor.destroy();
});

test('explicit destruction restores backdrop and ignores later source reconciliation', () => {
    const s = setup();
    const {actor, background, content} = s.wallpaper(null, false);
    assert.equal(content.brightness, 0);
    actor.setRendererAvailable(true);
    const pending = actor.syncRenderer.bind(actor);
    actor.destroy();
    assert.equal(s.actors.size, 0);
    assert.equal(background.handlers.size, 0);
    assert.deepEqual(content, {brightness: 0.5, vignette: false});
    pending();
    background.destroy();
});

test('daemon restart attaches only the new renderer even while the old window survives', () => {
    const s = setup();
    let r = s.renderer();
    const {actor, background} = s.wallpaper(r.launcher);
    for (let i = 0; i < 3; i++) {
        const old = r;
        const clone = actor._cloneActor;
        actor.setRendererAvailable(false);
        actor.setRendererLauncher(null);
        assert.ok(clone.disposed);
        assert.equal(old.actor.handlers.size, 0);
        r = s.renderer();
        actor.setRendererLauncher(r.launcher);
        actor.setRendererAvailable(true);
        assert.equal(actor._cloneActor.source, r.actor);
        old.actor.destroy();
        assert.equal(actor._cloneActor.source, r.actor);
    }
    background.destroy();
});

test('source destruction waits for reconciliation and parent destruction unregisters it', () => {
    const s = setup();
    const r = s.renderer();
    const {actor, background} = s.wallpaper(r.launcher);
    r.actor.destroy();
    assert.equal(actor._cloneActor, null);
    s.flush();
    assert.equal(actor._cloneActor, null);
    background.destroy();
    assert.equal(s.actors.size, 0);
});

test('overview reset restores the backdrop and reconnect dims it again', () => {
    const s = setup();
    const r = s.renderer();
    const {actor, background, content} = s.wallpaper(r.launcher, true, 'other');
    assert.deepEqual(content, {brightness: 0, vignette: true});
    actor.setRendererAvailable(false);
    assert.deepEqual(content, {brightness: 0.5, vignette: false});
    actor.setRendererAvailable(true);
    assert.equal(actor._cloneActor.source, r.actor);
    assert.deepEqual(content, {brightness: 0, vignette: true});
    background.destroy();
});

test('unexpected clone destruction disconnects source before attaching again', () => {
    const s = setup();
    const r = s.renderer();
    const {actor, background} = s.wallpaper(r.launcher);
    actor._cloneActor.destroy();
    assert.equal(r.actor.handlers.size, 0);
    assert.equal(actor._cloneActor, null);
    s.flush();
    assert.equal(actor._cloneActor.source, r.actor);
    assert.equal(r.actor.handlers.size, 1);
    background.destroy();
});

test('launcher replacement cannot retain the previous renderer clone', () => {
    const s = setup();
    const old = s.renderer();
    const {actor, background} = s.wallpaper(old.launcher);
    const clone = actor._cloneActor;
    const next = s.renderer();
    actor.setRendererLauncher(next.launcher);
    assert.ok(clone.disposed);
    assert.equal(old.actor.handlers.size, 0);
    assert.equal(actor._cloneActor.source, next.actor);
    background.destroy();
});

test('disconnecting a secondary output cannot blank or replace the primary wallpaper', () => {
    const s = setup();
    const primary = s.renderer('DP-1');
    const secondary = s.renderer('DP-2', {x: 1920, y: 0, width: 1920, height: 1080});
    const launcher = {ownsWindow: () => true};
    // Both MetaWindows now report monitor 0, including the disconnected one.
    s.windows.reverse();
    const {actor, background} = s.wallpaper(launcher);
    assert.equal(actor._cloneActor.source, primary.actor);
    s.flush();
    assert.equal(actor._cloneActor.source, primary.actor);
    assert.equal(s.Wallpaper.findRendererForMonitor(1, launcher), null);
    secondary.actor.destroy();
    background.destroy();
});

test('each output attaches independently while another renderer is not ready', () => {
    const s = setup();
    const geometry = {x: 1920, y: 0, width: 1920, height: 1080};
    s.setMonitors([{connector: 'DP-1', geometry: {x: 0, y: 0, width: 1920, height: 1080}},
        {connector: 'DP-2', geometry}]);
    const primary = s.renderer('DP-1');
    const launcher = {ownsWindow: () => true};
    assert.equal(s.Wallpaper.findRendererForMonitor(0, launcher), primary.actor);
    assert.equal(s.Wallpaper.findRendererForMonitor(1, launcher), null);
    const secondary = s.renderer('DP-2', geometry);
    assert.equal(s.Wallpaper.findRendererForMonitor(1, launcher), secondary.actor);
});

test('geometry fallback and ownership exclude migrated and previous renderer windows', () => {
    const s = setup();
    const primary = s.renderer(null);
    s.renderer(null, {x: 1920, y: 0, width: 1920, height: 1080});
    assert.equal(s.Wallpaper.findRendererForMonitor(0, primary.launcher), primary.actor);
    const replacement = s.renderer(null);
    assert.equal(s.Wallpaper.findRendererForMonitor(0, replacement.launcher), replacement.actor);
    assert.equal(s.Wallpaper.findRendererForMonitor(0, {ownsWindow: () => true}), null,
        'ambiguous old and new sources must not depend on actor enumeration order');
});

test('desktop binding follows a settled output mapping even while old sources survive', () => {
    const s = setup();
    const primary = s.renderer('DP-1');
    const secondary = s.renderer('DP-2', {x: 1920, y: 0, width: 1920, height: 1080});
    const launcher = {ownsWindow: () => true};
    // The initial mapping selects the other source during a layout transition.
    s.setMonitors([{connector: 'DP-2', geometry: {x: 0, y: 0, width: 1920, height: 1080}}]);
    const {actor, background} = s.wallpaper(launcher);
    const wrongClone = actor._cloneActor;
    assert.equal(wrongClone.source, secondary.actor);
    s.setMonitors([{connector: 'DP-1', geometry: {x: 0, y: 0, width: 1920, height: 1080}}]);
    s.flush();
    assert.ok(wrongClone.disposed);
    assert.equal(actor._cloneActor.source, primary.actor);
    assert.equal(secondary.actor.handlers.size, 0);
    const correctClone = actor._cloneActor;
    s.flush();
    assert.equal(actor._cloneActor, correctClone, 'an unchanged source must not restart the fade');
    background.destroy();
});

test('a surviving source stops painting as soon as it no longer matches any output', () => {
    const s = setup();
    const r = s.renderer('DP-1');
    const {actor, background} = s.wallpaper(r.launcher);
    const clone = actor._cloneActor;
    s.setMonitors([]);
    s.flush();
    assert.ok(clone.disposed);
    assert.equal(actor._cloneActor, null);
    assert.equal(r.actor.handlers.size, 0);
    background.destroy();
});
