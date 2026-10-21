import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {Actor, Signals} from './actors.mjs';

function setup() {
    const pending = new Map();
    const errors = [];
    let nextId = 1;
    let scans = 0;
    let monitors = [
        {connector: 'DP-1', x: 0, y: 0, width: 1920, height: 1080},
        {connector: 'DP-2', x: 1920, y: 0, width: 2560, height: 1440},
    ];
    const windows = [];
    const group = new Actor();
    const layoutManager = Object.assign(new Signals(), {
        overviewGroup: group, _backgroundGroup: new Actor(), _bgManagers: [],
        _updateBackgrounds() {},
    });
    const global = {
        window_manager: new Signals(),
        get_window_actors: () => [], // Another extension can hide our windows here.
        backend: {get_monitor_manager: () => ({get_monitor_for_connector:
            connector => monitors.findIndex(m => m.connector === connector)})},
        display: {list_all_windows: () => {
                scans++;
                return windows.filter(actor => !actor.disposed).map(actor => actor.meta_window);
            }, get_n_monitors: () => monitors.length,
            get_monitor_geometry: index => monitors[index]},
    };
    class BackgroundManager {
        constructor(index, container) {
            this._monitorIndex = index;
            this._container = container;
            this.backgroundActor = this._createBackgroundActor();
        }
        _createBackgroundActor() {
            const actor = new Actor({monitor: this._monitorIndex,
                content: {brightness: 0.5, vignette: false}});
            this._container.add_child(actor);
            return actor;
        }
        destroy() { this.backgroundActor.destroy(); this.backgroundActor = null; }
    }
    class InjectionManager {
        originals = [];
        overrideMethod(proto, name, factory) {
            this.originals.push([proto, name, proto[name]]);
            proto[name] = factory(proto[name]);
        }
        clear() { for (const [proto, name, original] of this.originals) proto[name] = original; }
    }
    const read = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const BlurController = class {setState() {} destroy() {}};
    const Clutter = {Clone: Actor, FixedLayout: class {}, BinLayout: class {}, AnimationMode: {}};
    const Wallpaper = vm.runInNewContext(`${read('wallpaper.js')}\n({collectRenderers, APPLICATION_ID, WallpaperRole, LiveWallpaper})`, {
        global, GObject: {registerClass: klass => klass}, St: {Widget: Actor},
        Clutter, BlurController, PauseEffectKind: {BLUR: 'blur'},
    });
    const Override = vm.runInNewContext(`${read('gnomeShellOverride.js')}\nGnomeShellOverride`, {
        Wallpaper, global, InjectionManager, Clutter, BlurController,
        Main: {layoutManager, sessionMode: {isLocked: false}},
        Background: {BackgroundManager},
        Shell: {Global: class {}, WindowTracker: class {}, App: class {}, AppSystem: class {}},
        Meta: {Display: class {}}, Workspace: {Workspace: class {}},
        WorkspaceThumbnail: {WorkspaceThumbnail: class {}},
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
            idle_add(_priority, callback) { const id = nextId++; pending.set(id, callback); return id; },
            source_remove(id) { assert.ok(pending.delete(id)); },
            timeout_add() { assert.fail('wallpaper synchronization must not poll'); }},
        logError(error, message) { errors.push({error, message}); },
    });
    const override = new Override(null);
    override.enable();
    override.setRendererLauncher({ownsWindow: window => window.owner === 1});
    override.setRendererAvailable(true);
    function background(index = 0, role = 'desktop') {
        const manager = new BackgroundManager(index,
            role === 'desktop' ? layoutManager._backgroundGroup : new Actor());
        if (role === 'desktop') layoutManager._bgManagers.push(manager);
        return manager;
    }
    function renderer(connector, owner = 1, ready = true) {
        const window = Object.assign(new Signals(), {owner, get_monitor: () => 0});
        const actor = new Actor({width: 1920, height: 1080, meta_window: window});
        window.get_compositor_private = () => actor;
        actor.setHints = hints => {
            window.title = `@${Wallpaper.APPLICATION_ID}!${JSON.stringify(hints)}`;
            window.emit('notify::title');
        };
        actor.setHints({connector, presentationReady: ready});
        windows.push(actor);
        global.window_manager.emit('map', actor);
        return actor;
    }
    return {override, group, background, renderer, pending, errors, global, layoutManager,
        view(manager) { return override._backgrounds.get(manager.backgroundActor)?.actor; },
        overviewSource(index) { return override._overviewClones.find(e => e.monitor === index)?.clone.source; },
        get scans() { return scans; },
        setMonitors(next) { monitors = next; layoutManager.emit('monitors-changed'); },
        flush() {
            let calls = 0;
            while (pending.size) {
                assert.ok(++calls < 25, 'reconciliation did not settle');
                const [id, callback] = pending.entries().next().value;
                pending.delete(id);
                assert.equal(callback(), false);
            }
            return calls;
        },
    };
}

test('events coalesce into one source snapshot shared by desktop and overview without polling', () => {
    const s = setup();
    const main = s.background();
    const secondary = s.background(1);
    const secondSource = s.renderer('DP-2');
    const firstSource = s.renderer('DP-1');
    assert.equal(s.pending.size, 1);
    assert.equal(s.flush(), 1);
    assert.equal(s.scans, 1);
    assert.equal(s.view(main)._cloneActor.source, firstSource);
    assert.equal(s.overviewSource(0), firstSource);
    assert.equal(s.view(secondary)._cloneActor.source, secondSource);
    assert.equal(s.overviewSource(1), secondSource);
    assert.equal(s.pending.size, 0, 'steady state has no scheduled work');
    assert.equal(s.errors.length, 0);
});

test('readiness, first frame and size changes synchronize views without another map event', () => {
    const s = setup();
    const main = s.background();
    const source = s.renderer('DP-1', 1, false);
    s.flush();
    assert.equal(s.view(main)._cloneActor, null);
    source.setHints({connector: 'DP-1', presentationReady: true});
    source.width = 0;
    s.flush();
    assert.equal(s.view(main)._cloneActor, null);
    source.width = 1920;
    source.emit('first-frame');
    source.emit('notify::width');
    source.emit('notify::height');
    assert.equal(s.flush(), 1);
    assert.equal(s.view(main)._cloneActor.source, source);
    assert.equal(s.overviewSource(0), source);
});

test('disconnecting and reindexing outputs preserves their source identity', () => {
    const s = setup();
    const primary = s.background();
    const secondary = s.background(1);
    const first = s.renderer('DP-1');
    const second = s.renderer('DP-2');
    s.flush();
    secondary.destroy();
    s.layoutManager._bgManagers.pop();
    s.setMonitors([{connector: 'DP-1', x: 0, y: 0, width: 1920, height: 1080}]);
    s.flush();
    assert.equal(s.view(primary)._cloneActor.source, first);
    assert.equal(s.override._overviewClones.length, 1);
    assert.equal(s.overviewSource(0), first);
    s.setMonitors([{connector: 'DP-2', x: 0, y: 0, width: 1920, height: 1080}]);
    s.flush();
    assert.equal(s.view(primary)._cloneActor.source, second);
    assert.equal(s.overviewSource(0), second);
});

test('ambiguity and renderer replacement discard old sources for every view', () => {
    const s = setup();
    const main = s.background();
    const old = s.renderer('DP-1');
    const second = s.renderer('DP-2');
    s.flush();
    const duplicate = s.renderer('DP-1');
    s.flush();
    assert.equal(s.view(main)._cloneActor, null);
    assert.equal(s.overviewSource(0), undefined);
    assert.equal(s.overviewSource(1), second);
    duplicate.destroy();
    s.flush();
    assert.equal(s.view(main)._cloneActor.source, old);
    const next = s.renderer('DP-1', 2);
    s.override.setRendererLauncher({ownsWindow: window => window.owner === 2});
    s.flush();
    assert.equal(s.view(main)._cloneActor.source, next);
    assert.equal(s.overviewSource(0), next);
    assert.equal(old.handlers.size, 0);
    assert.equal(old.meta_window.handlers.size, 0);
    s.override.setRendererAvailable(false);
    s.flush();
    assert.equal(s.view(main)._cloneActor, null);
    assert.equal(s.group.children.size, 0);
    s.override.setRendererLauncher(null);
    s.override.setRendererAvailable(true);
    s.flush();
    assert.equal(s.view(main)._cloneActor, null);
});

test('destroyed desktop and overview-preview components recover after teardown completes', () => {
    const s = setup();
    const main = s.background();
    const preview = s.background(1, 'other');
    const source = s.renderer('DP-1');
    s.renderer('DP-2');
    s.flush();
    const first = s.view(main);
    const oldCallback = first._onDestroyed;
    first.destroy();
    s.view(preview).destroy();
    assert.equal(main.backgroundActor.children.size, 0, 'do not recreate inside destroy');
    assert.equal(s.pending.size, 1);
    s.flush();
    assert.notEqual(s.view(main), first);
    assert.equal(s.view(main)._cloneActor.source, source);
    assert.equal(main.backgroundActor.children.size, 1);
    assert.equal(preview.backgroundActor.children.size, 1);
    oldCallback(first);
    assert.equal(s.pending.size, 0, 'a late callback cannot invalidate the replacement');
});

test('detached and reparented live components return to their owning background', () => {
    const s = setup();
    const main = s.background();
    s.renderer('DP-1');
    s.flush();
    const actor = s.view(main);
    const clone = actor._cloneActor;
    main.backgroundActor.remove_child(actor);
    const foreign = new Actor();
    foreign.add_child(actor);
    s.flush();
    assert.equal(actor.get_parent(), main.backgroundActor);
    assert.equal(actor._cloneActor, clone);
    assert.equal(foreign.children.size, 0);
    assert.equal(main.backgroundActor.children.size, 1);
});

test('background destruction also disposes a detached component and never resurrects it', () => {
    const s = setup();
    const manager = s.background();
    s.renderer('DP-1');
    s.flush();
    const actor = s.view(manager);
    manager.backgroundActor.remove_child(actor);
    manager.destroy();
    s.layoutManager._bgManagers.pop();
    s.flush();
    assert.ok(actor.disposed);
    assert.equal(s.override._backgrounds.size, 0);
    assert.equal(s.errors.length, 0);
});

test('unexpected clone destruction and removal recover desktop and overview displays', () => {
    const s = setup();
    const main = s.background();
    const source = s.renderer('DP-1');
    s.flush();
    s.view(main)._cloneActor.destroy();
    s.override._overviewClones[0].clone.destroy();
    s.flush();
    assert.equal(s.view(main)._cloneActor.source, source);
    assert.equal(s.overviewSource(0), source);
    const desktopClone = s.view(main)._cloneActor;
    s.view(main).remove_child(desktopClone);
    s.flush();
    assert.equal(desktopClone.get_parent(), s.view(main));
    assert.equal(s.view(main)._cloneActor, desktopClone);
    const clone = s.override._overviewClones[0].clone;
    s.group.remove_child(clone);
    s.flush();
    assert.equal(clone.get_parent(), s.group);
    source.destroy();
    s.flush();
    assert.equal(s.view(main)._cloneActor, null);
    assert.equal(s.override._overviewClones.length, 0);
    assert.equal(s.override._sources.size, 0);
});

test('overview settings do not stop desktop synchronization and cleanup is reentrant', () => {
    const s = setup();
    const main = s.background();
    const source = s.renderer('DP-1');
    s.flush();
    s.override._overviewWallpaper = false;
    s.override._queueSync();
    s.flush();
    assert.equal(s.group.children.size, 0);
    s.view(main).destroy();
    s.flush();
    assert.equal(s.view(main)._cloneActor.source, source);
    s.override._overviewWallpaper = true;
    s.override._queueSync();
    s.flush();
    const clones = [...s.group.children];
    s.override._invalidateOverviewClones();
    assert.ok(clones.every(clone => clone.disposed));
    assert.equal(s.override._overviewClones.length, 0);
    assert.equal(s.pending.size, 0, 'intentional cleanup must not recreate clones');
});

test('disable cancels pending work, disconnects signals and restores native backgrounds', () => {
    const s = setup();
    const main = s.background();
    const source = s.renderer('DP-1');
    s.flush();
    main.backgroundActor.remove_child(s.view(main));
    s.override.disable();
    assert.equal(s.pending.size, 0);
    assert.equal(s.override._backgrounds.size, 0);
    assert.equal(s.override._sources.size, 0);
    assert.equal(s.group.handlers.size, 0);
    assert.equal(main.backgroundActor.handlers.size, 0);
    assert.equal(main.backgroundActor.content.brightness, 0.5);
    assert.equal(source.handlers.size, 0);
    assert.equal(source.meta_window.handlers.size, 0);
    assert.equal(s.layoutManager.handlers.size, 0);
    assert.equal(s.global.window_manager.handlers.size, 0);
    source.setHints({connector: 'DP-1', presentationReady: true});
    s.global.window_manager.emit('map', source);
    assert.equal(s.pending.size, 0);
});

test('synchronization failures are logged and do not prevent other backgrounds updating', () => {
    const s = setup();
    const first = s.background();
    const second = s.background(1);
    const main = s.renderer('DP-1');
    const secondary = s.renderer('DP-2');
    s.flush();
    s.view(first).syncRenderer = () => { throw new Error('test background failure'); };
    s.view(second)._cloneActor.destroy();
    s.flush();
    assert.equal(s.errors.length, 1);
    assert.match(s.errors[0].message, /monitor 0/);
    assert.equal(s.view(second)._cloneActor.source, secondary);
    assert.equal(s.overviewSource(0), main);
    s.global.display.list_all_windows = () => { throw new Error('test snapshot failure'); };
    s.override._queueSync();
    s.flush();
    assert.equal(s.errors.length, 2);
    assert.match(s.errors[1].message, /synchronize wallpaper views/);
});
