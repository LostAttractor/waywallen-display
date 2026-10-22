import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {Actor} from './actors.mjs';

function setup() {
    const windows = [];
    let changes = 0;
    let monitors = [{connector: 'DP-1', geometry: {x: 0, y: 0, width: 1920, height: 1080}}];
    const source = readFileSync(new URL('../extension/wallpaper.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const Wallpaper = vm.runInNewContext(`${source}\n({LiveWallpaper, APPLICATION_ID, collectRenderers})`, {
        St: {Widget: Actor}, GObject: {registerClass: klass => klass},
        Clutter: {Clone: Actor, FixedLayout: class {}, BinLayout: class {}, AnimationMode: {}},
        BlurController: class {setState() {} destroy() {}},
        PauseEffectKind: {BLUR: 'blur'},
        global: {
            backend: {get_monitor_manager: () => ({get_monitor_for_connector:
                connector => monitors.findIndex(m => m.connector === connector)})},
            display: {get_n_monitors: () => monitors.length,
                get_monitor_geometry: index => monitors[index].geometry}},
    });
    function renderer(connector = 'DP-1', geometry = monitors[0].geometry) {
        const hints = JSON.stringify({presentationReady: true, connector, geometry});
        const actor = new Actor({width: 1920, height: 1080, meta_window: {
            title: `@${Wallpaper.APPLICATION_ID}!${hints}`, get_monitor: () => 0,
        }});
        windows.push(actor);
        return {actor, launcher: {ownsWindow: window => window === actor.meta_window}};
    }
    function wallpaper(role = 'desktop') {
        const background = new Actor({monitor: 0});
        const content = {brightness: 0.5, vignette: false};
        Object.defineProperty(background, 'content', {get() {
            assert.ok(!background.destroying && !background.disposed, 'read disposing background');
            return content;
        }});
        let removed = false;
        const actor = new Wallpaper.LiveWallpaper(background, role,
            () => { removed = true; }, () => changes++);
        const parentId = background.connect('destroy', () => actor.destroyWithBackground());
        return {actor, background, content, get removed() { return removed; },
            detachOwner() { background.disconnect(parentId); }};
    }
    return {renderer, wallpaper, get changes() { return changes; },
        sources(launcher = {ownsWindow: () => true}) {
            return Wallpaper.collectRenderers(windows.filter(w => !w.disposed), launcher);
        }, setMonitors(next) { monitors = next; }};
}

test('parent disposal releases the view and preserves default child destruction', () => {
    const s = setup();
    const r = s.renderer();
    const view = s.wallpaper();
    view.actor.syncRenderer(r.actor);
    const clone = view.actor._cloneActor;
    const extra = new Actor();
    view.actor.add_child(extra);
    view.background.destroy();
    assert.ok(view.removed);
    assert.ok(view.actor.disposed && clone.disposed && extra.disposed);
    assert.equal(r.actor.handlers.size, 0);
    view.actor.syncRenderer(r.actor);
    view.actor.setPresentation(null);
    r.actor.destroy();
});

test('explicit destruction restores the backdrop and ignores later synchronization', () => {
    const s = setup();
    const view = s.wallpaper();
    assert.equal(view.content.brightness, 0);
    const r = s.renderer();
    view.actor.destroy();
    assert.ok(view.removed);
    assert.deepEqual(view.content, {brightness: 0.5, vignette: false});
    view.actor.syncRenderer(r.actor);
    assert.equal(r.actor.handlers.size, 0);
    view.detachOwner();
    view.background.destroy();
});

test('source replacement releases old callbacks and preserves an unchanged clone', () => {
    const s = setup();
    const old = s.renderer();
    const next = s.renderer();
    const {actor} = s.wallpaper();
    actor.syncRenderer(old.actor);
    const clone = actor._cloneActor;
    actor.syncRenderer(next.actor);
    assert.ok(clone.disposed);
    assert.equal(old.actor.handlers.size, 0);
    assert.equal(actor._cloneActor.source, next.actor);
    const healthy = actor._cloneActor;
    actor.syncRenderer(next.actor);
    assert.equal(actor._cloneActor, healthy);
    old.actor.destroy();
    assert.equal(actor._cloneActor.source, next.actor);
});

test('source and clone destruction request reconciliation and release stale bindings', () => {
    const s = setup();
    const r = s.renderer();
    const {actor} = s.wallpaper();
    actor.syncRenderer(r.actor);
    actor._cloneActor.destroy();
    assert.equal(s.changes, 1);
    assert.equal(r.actor.handlers.size, 0);
    actor.syncRenderer(r.actor);
    r.actor.destroy();
    assert.equal(s.changes, 2);
    assert.equal(actor._cloneActor, null);
});

test('overview fallback restores brightness while the desktop fallback remains black', () => {
    const s = setup();
    const r = s.renderer();
    const {actor, content} = s.wallpaper('other');
    assert.deepEqual(content, {brightness: 0.5, vignette: false});
    actor.syncRenderer(r.actor);
    assert.deepEqual(content, {brightness: 0, vignette: true});
    actor.syncRenderer(null);
    assert.deepEqual(content, {brightness: 0.5, vignette: false});
    const desktop = s.wallpaper();
    desktop.actor.syncRenderer(null);
    assert.deepEqual(desktop.content, {brightness: 0, vignette: true});
});

test('overview previews show ready frames immediately while keeping the placeholder black', () => {
    const s = setup();
    const first = s.renderer();
    const next = s.renderer();
    const view = s.wallpaper('other');
    assert.equal(view.actor.opacity, 0);
    for (const source of [first.actor, next.actor]) {
        view.actor.syncRenderer(source);
        const clone = view.actor._cloneActor;
        assert.equal(view.actor.opacity, 255);
        assert.equal(clone.opacity, 255);
        assert.equal(clone.easeCalls.length, 0, 'ready overview frames must not fade from black');
        assert.deepEqual(view.content, {brightness: 0, vignette: true});
        view.actor.syncRenderer(null);
        assert.ok(clone.disposed);
        assert.equal(view.actor.opacity, 0);
        assert.deepEqual(view.content, {brightness: 0.5, vignette: false});
    }
    view.background.destroy();
});

test('desktop attachment keeps its fade without restarting unchanged bindings', () => {
    const s = setup();
    const source = s.renderer();
    const view = s.wallpaper();
    view.actor.syncRenderer(source.actor);
    const clone = view.actor._cloneActor;
    assert.equal(clone.easeCalls.length, 1);
    assert.equal(clone.easeCalls[0].from, 0);
    assert.equal(clone.easeCalls[0].opacity, 255);
    assert.equal(clone.easeCalls[0].duration, 800);
    view.actor.syncRenderer(source.actor);
    assert.equal(view.actor._cloneActor, clone);
    assert.equal(clone.easeCalls.length, 1);
    view.background.destroy();
});

test('output identity excludes a migrated disconnected source', () => {
    const s = setup();
    s.renderer('DP-2', {x: 1920, y: 0, width: 1920, height: 1080});
    const primary = s.renderer('DP-1');
    assert.equal(s.sources().size, 1);
    assert.equal(s.sources().get(0), primary.actor);
    s.setMonitors([]);
    assert.equal(s.sources().size, 0);
});

test('outputs become ready independently and zero-sized sources are excluded', () => {
    const s = setup();
    const geometry = {x: 1920, y: 0, width: 1920, height: 1080};
    s.setMonitors([{connector: 'DP-1', geometry: {x: 0, y: 0, width: 1920, height: 1080}},
        {connector: 'DP-2', geometry}]);
    const primary = s.renderer('DP-1');
    const secondary = s.renderer('DP-2', geometry);
    secondary.actor.width = 0;
    assert.equal(s.sources().get(0), primary.actor);
    assert.equal(s.sources().has(1), false);
    secondary.actor.width = 1920;
    assert.equal(s.sources().get(1), secondary.actor);
});

test('geometry fallback, ownership and ambiguity do not depend on enumeration order', () => {
    const s = setup();
    const primary = s.renderer(null);
    s.renderer(null, {x: 1920, y: 0, width: 1920, height: 1080});
    assert.equal(s.sources(primary.launcher).get(0), primary.actor);
    const next = s.renderer(null);
    assert.equal(s.sources(next.launcher).get(0), next.actor);
    s.renderer(null);
    assert.equal(s.sources().has(0), false, 'three candidates must remain ambiguous');
    assert.equal(s.sources(null).size, 0);
});
