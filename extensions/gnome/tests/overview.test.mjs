// Run with: node --test extensions/gnome/tests/overview.test.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function setup() {
    const timers = new Map();
    let nextTimer = 1;
    let monitors = [
        {connector: 'DP-1', x: 0, y: 0, width: 1920, height: 1080},
        {connector: 'DP-2', x: 1920, y: 0, width: 2560, height: 1440},
    ];
    const windows = [];
    const group = {children: new Set(),
        add_child(child) { this.children.add(child); },
        remove_child(child) { this.children.delete(child); this.onRemoved?.(child); },
        connect() { return 1; }, get_children() { return []; },
        set_child_below_sibling() {}, set_child_above_sibling() {}};
    class Clone {
        constructor(props) { Object.assign(this, props); }
        ease() {}
        set_position() {}
        set_scale() {}
        get_parent() { assert.ok(!this.destroyed, 'accessed disposed clone'); return group; }
        destroy() { assert.ok(!this.destroyed); this.destroyed = true; }
    }
    const global = {
        backend: {get_monitor_manager: () => ({get_monitor_for_connector:
            connector => monitors.findIndex(m => m.connector === connector)})},
        display: {list_all_windows: () => windows.map(w => w.meta_window),
            get_n_monitors: () => monitors.length,
            get_monitor_geometry: index => monitors[index]},
    };
    const wallpaperSource = readFileSync(new URL('../extension/wallpaper.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const Wallpaper = vm.runInNewContext(`${wallpaperSource}\n({findRendererForMonitor, APPLICATION_ID, WallpaperRole})`, {
        global, GObject: {registerClass: klass => klass}, St: {Widget: class {}},
    });
    Wallpaper.LiveWallpaper = class {
        constructor(background, role, _available, _launcher, onDestroyed) {
            this.background = background;
            this.role = role;
            this.monitorIndex = background.monitor;
            this.onDestroyed = onDestroyed;
            background.children.add(this);
        }
        syncRenderer() {}
        setPresentation() {}
        destroy() {
            this.background.children.delete(this);
            this.onDestroyed(this);
        }
    };
    const Main = {layoutManager: {overviewGroup: group, _bgManagers: []}};
    const overrideSource = readFileSync(new URL('../extension/gnomeShellOverride.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const Override = vm.runInNewContext(`${overrideSource}\nGnomeShellOverride`, {
        Wallpaper, global, InjectionManager: class {},
        Main,
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true,
            timeout_add(_priority, _delay, callback) {
                const id = nextTimer++;
                timers.set(id, callback);
                return id;
            }, source_remove(id) { assert.ok(timers.delete(id)); }},
        Clutter: {Clone, AnimationMode: {}},
        BlurController: class {setState() {} destroy() {}},
    });
    const override = new Override(null);
    Object.assign(override, {_overviewWallpaper: true, _rendererAvailable: true,
        _rendererLauncher: {ownsWindow: () => true}, _overviewClones: [], _overviewGroup: group,
        _repositionOverviewBackdrop() {}});
    function renderer(connector, owner = 1) {
        const hints = JSON.stringify({connector, presentationReady: true});
        const actor = {width: 1920, height: 1080, meta_window: {
            title: `@${Wallpaper.APPLICATION_ID}!${hints}`, owner,
            // Deliberately report the same current monitor for every window.
            get_monitor: () => 0,
        }};
        actor.meta_window.get_compositor_private = () => actor;
        windows.push(actor);
        return actor;
    }
    return {override, group, renderer, windows, timers, Main,
        reposition() { Override.prototype._repositionOverviewBackdrop.call(override); },
        setMonitors(next) { monitors = next; },
        sync() { override._syncOverviewBackdrop(); }};
}

test('overview uses the same output identity as desktop and prunes removed outputs', () => {
    const s = setup();
    const secondary = s.renderer('DP-2'); // List the secondary first.
    const primary = s.renderer('DP-1');
    s.sync();
    assert.equal(s.override._overviewClones[0].clone.source, primary);
    assert.equal(s.override._overviewClones[1].clone.source, secondary);
    const oldSecondaryClone = s.override._overviewClones[1].clone;
    s.setMonitors([{connector: 'DP-1', x: 0, y: 0, width: 1920, height: 1080}]);
    s.sync();
    assert.equal(s.override._overviewClones.length, 1);
    assert.equal(s.override._overviewClones[0].clone.source, primary);
    assert.ok(oldSecondaryClone.destroyed);
    assert.equal(s.group.children.size, 1, 'a surviving old source must not retain an off-screen clone');
});

test('ambiguous output sources are hidden without blanking other ready outputs', () => {
    const s = setup();
    s.renderer('DP-1');
    const secondary = s.renderer('DP-2');
    s.sync();
    const oldPrimaryClone = s.override._overviewClones[0].clone;
    s.renderer('DP-1');
    s.sync();
    assert.ok(oldPrimaryClone.destroyed);
    assert.equal(s.override._overviewClones.length, 1);
    assert.equal(s.override._overviewClones[0].clone.source, secondary);
});

test('renderer restart and daemon disappearance immediately discard old overview clones', () => {
    const s = setup();
    s.renderer('DP-1');
    s.renderer('DP-2');
    s.sync();
    const oldClones = [...s.group.children];
    const nextPrimary = s.renderer('DP-1', 2);
    s.renderer('DP-2', 2);
    s.override.setRendererLauncher({ownsWindow: window => window.owner === 2});
    assert.ok(oldClones.every(clone => clone.destroyed));
    assert.equal(s.override._overviewClones[0].clone.source, nextPrimary);
    s.override.setRendererAvailable(false);
    assert.equal(s.group.children.size, 0);
    assert.equal(s.override._overviewClones.length, 0);
    s.override.setRendererLauncher(null);
    s.override.setRendererAvailable(true);
    assert.equal(s.group.children.size, 0, 'old renderer windows must not be reused without a launcher');
});

test('the shared refresh reconciles desktop bindings even with overview wallpaper disabled', () => {
    const s = setup();
    let reconciled = 0;
    s.override._wallpapers.set({}, {syncRenderer() { reconciled++; }});
    s.override._overviewWallpaper = false;
    s.override._setupOverviewBackdrop();
    assert.equal(reconciled, 1);
    assert.equal(s.timers.size, 1, 'all background actors share one refresh source');
    const refresh = [...s.timers.values()][0];
    assert.equal(refresh(), true);
    assert.equal(reconciled, 2);
    s.override._teardownOverviewBackdrop();
    assert.equal(s.timers.size, 0);
});

test('clone cleanup unregisters sources before child removal re-enters positioning', () => {
    const s = setup();
    s.renderer('DP-1');
    s.renderer('DP-2');
    s.sync();
    const clones = [...s.group.children];
    s.group.onRemoved = () => s.reposition();
    s.override._invalidateOverviewClones();
    assert.ok(clones.every(clone => clone.destroyed));
    assert.equal(s.override._overviewClones.length, 0);
    assert.equal(s.group.children.size, 0);
});

test('desktop components follow the current background and recover when only the child was destroyed', () => {
    const s = setup();
    const background = {monitor: 0, children: new Set()};
    const manager = {backgroundActor: background};
    s.Main.layoutManager._bgManagers.push(manager);
    s.override._syncRenderers();
    const first = manager.waywallenActor;
    assert.equal(first.role, 'desktop');
    assert.equal(background.children.size, 1);
    first.destroy();
    assert.equal(s.override._wallpapers.size, 0);
    assert.equal(background.children.size, 0);
    s.override._syncRenderers();
    const replacement = manager.waywallenActor;
    assert.notEqual(replacement, first);
    assert.equal(background.children.size, 1);
    s.override._syncRenderers();
    assert.equal(manager.waywallenActor, replacement, 'reuse the owned component on later refreshes');
    assert.equal(background.children.size, 1);
    // A late callback from the old component cannot unregister its replacement.
    first.onDestroyed(first);
    assert.equal(s.override._wallpapers.get(background), replacement);
});

test('replacing a GNOME background attaches to the new parent and releases the old one', () => {
    const s = setup();
    const manager = {backgroundActor: {monitor: 0, children: new Set()}};
    s.Main.layoutManager._bgManagers.push(manager);
    s.override._syncRenderers();
    const old = manager.waywallenActor;
    old.destroy();
    manager.backgroundActor = {monitor: 0, children: new Set()};
    s.override._syncRenderers();
    assert.notEqual(manager.waywallenActor, old);
    assert.equal(s.override._wallpapers.size, 1);
    assert.equal(s.override._wallpapers.get(manager.backgroundActor), manager.waywallenActor);
});
