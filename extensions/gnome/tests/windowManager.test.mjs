import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class Signals {
    handlers = new Map();
    nextId = 1;
    connect(name, callback) {
        const id = this.nextId++;
        this.handlers.set(id, {name, callback});
        return id;
    }
    connect_after(name, callback) { return this.connect(name, callback); }
    disconnect(id) { assert.ok(this.handlers.delete(id)); }
    emit(name, ...args) {
        for (const [id, handler] of [...this.handlers]) {
            if (this.handlers.has(id) && handler.name === name)
                handler.callback(this, ...args);
        }
    }
}

function setup() {
    const pending = new Map();
    let nextId = 1;
    const layout = new Signals();
    const login = new Signals();
    const wm = new Signals();
    const display = Object.assign(new Signals(), {
        list_all_windows() { assert.fail('recovery must only visit managed renderer windows'); },
    });
    const launcher = {ownsWindow: window => window.owned,
        setWindowListVisible(window, visible) { window.skip_taskbar = !visible; }};
    const source = readFileSync(new URL('../extension/windowManager.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const Manager = vm.runInNewContext(`${source}\nWindowManager`, {
        Wallpaper: {APPLICATION_ID: 'io.github.waywallen.WaywallenRenderer'},
        Main: {layoutManager: layout}, getLoginManager: () => login,
        global: {window_manager: wm, display},
        GLib: {PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 200, SOURCE_REMOVE: false,
            idle_add(_priority, callback) { const id = nextId++; pending.set(id, callback); return id; },
            source_remove(id) { assert.ok(pending.delete(id)); }},
    });
    const manager = new Manager();
    manager.enable();
    manager.setLauncher(launcher);
    function window(owned = true) {
        return Object.assign(new Signals(), {owned, minimized: false, above: false,
            skip_taskbar: false,
            title: owned ? '@io.github.waywallen.WaywallenRenderer!' + JSON.stringify({
                keepAtBottom: true, keepMinimized: true, keepPosition: false}) : 'ordinary application',
            minimize() {
                if (this.skip_taskbar || this.minimized) return;
                this.minimized = true;
                this.emit('notify::minimized');
            },
            lower() { this.lowered = true; },
            unmake_above() { this.above = false; this.emit('notify::above'); }});
    }
    return {manager, window, layout, login, wm, display, pending,
        map(w) { wm.emit('map', {get_meta_window: () => w}); },
        flush() {
            let count = 0;
            while (pending.size) {
                assert.ok(++count < 30, 'window restoration did not settle');
                const [id, callback] = pending.entries().next().value;
                pending.delete(id); assert.equal(callback(), false);
            }
        }};
}

function assertHidden(window) {
    assert.equal(window.minimized, true);
    assert.equal(window.above, false);
    assert.equal(window.skip_taskbar, true);
}

test('a known renderer remapping restores its native hiding constraints', () => {
    const s = setup();
    const w = s.window();
    s.map(w); s.flush(); assertHidden(w);
    Object.assign(w, {minimized: false, above: true, skip_taskbar: false});
    s.map(w); s.flush(); assertHidden(w);
    assert.equal(s.manager._managed.size, 1);
    s.manager.disable();
});

test('resume, restacking and monitor changes restore only managed renderer windows', () => {
    const s = setup();
    const w = s.window();
    const app = s.window(false);
    s.map(w); s.map(app); s.flush();
    for (const event of ['resume', 'restack', 'monitors']) {
        Object.assign(w, {minimized: false, above: true, skip_taskbar: false});
        if (event === 'resume') s.login.emit('prepare-for-sleep', false);
        else if (event === 'restack') s.display.emit('restacked');
        else s.layout.emit('monitors-changed');
        s.flush(); assertHidden(w);
    }
    assert.equal(app.minimized, false);
    assert.equal(app.skip_taskbar, false);
    s.manager.disable();
});

test('unmanaged sources are removed before queued recovery', () => {
    const s = setup();
    const w = s.window();
    s.map(w);
    s.display.emit('restacked');
    w.emit('unmanaged');
    s.flush();
    assert.equal(s.manager._managed.size, 0);
    assert.equal(w.handlers.size, 0);
    s.display.emit('restacked');
    assert.equal(s.pending.size, 0);
    s.manager.disable();
});

test('disable cancels coalesced recovery and releases every window and session signal', () => {
    const s = setup();
    const w = s.window();
    s.map(w); s.flush();
    s.display.emit('restacked');
    s.layout.emit('monitors-changed');
    s.login.emit('prepare-for-sleep', false);
    assert.equal(s.pending.size, 1);
    s.manager.disable();
    assert.equal(s.pending.size, 0);
    assert.equal(w.handlers.size, 0);
    assert.equal(s.layout.handlers.size + s.login.handlers.size + s.display.handlers.size + s.wm.handlers.size, 0);
});
