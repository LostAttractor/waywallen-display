// Run with: node --test extensions/gnome/tests/monitors.test.mjs
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
    disconnect(id) { assert.ok(this.handlers.delete(id)); }
    emit(name, ...args) {
        for (const [id, handler] of [...this.handlers]) {
            if (this.handlers.has(id) && handler.name === name)
                handler.callback(this, ...args);
        }
    }
}

function monitor(connector, x = 0, scale = 1) {
    return Object.assign(new Signals(), {
        connector, geometry: {x, y: 0, width: 1920, height: 1080}, scale, refresh: 60000, valid: true,
        get_connector() { return this.connector; },
        get_geometry() { return this.geometry; },
        get_scale() { return this.scale; },
        get_refresh_rate() { return this.refresh; },
        is_valid() { return this.valid; },
        change(property, value) {
            this[property] = value;
            this.emit('notify', {name: property});
        },
    });
}

function setup(initial) {
    const timers = new Map();
    let nextTimer = 1;
    const app = {holds: 0, hold() { this.holds++; }, release() { this.holds--; }};
    const monitors = Object.assign(new Signals(), {
        items: initial,
        get_n_items() { return this.items.length; },
        get_item(index) { return this.items[index]; },
        replace(items) { this.items = items; this.emit('items-changed'); },
    });
    const renderers = [];
    const built = [];
    class Renderer {
        constructor(mon, index, opts) {
            this.monitor = mon;
            this._index = index;
            this.instanceId = `${opts.instanceId}:${mon.get_connector()}`;
        }
        build() { built.push(this); }
        destroy() { assert.ok(!this.destroyed); this.destroyed = true; }
        _updateWindowTitle() {}
    }
    const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
    const managerSource = source.slice(source.indexOf('class MonitorRenderers'), source.indexOf('\nconst opts ='));
    const Manager = vm.runInNewContext(`${managerSource}\nMonitorRenderers`, {
        renderers, MonitorRenderer: Renderer, monitorKey: mon => mon.get_connector(),
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
            timeout_add(_priority, _delay, callback) {
                const id = nextTimer++;
                timers.set(id, callback);
                return id;
            },
            source_remove(id) { assert.ok(timers.delete(id)); }},
    });
    const manager = new Manager(app, monitors, {instanceId: 'stable'});
    manager.start();
    return {manager, app, monitors, renderers, built, timers, flush() {
        for (const [id, callback] of [...timers]) {
            timers.delete(id);
            assert.equal(callback(), false);
        }
    }};
}

test('remove and reconnect secondary output without restarting the primary renderer', () => {
    const primary = monitor('DP-1');
    const secondary = monitor('DP-2', 1920, 1.5);
    const s = setup([primary, secondary]);
    const [p, oldSecondary] = s.renderers;
    s.monitors.replace([primary]);
    assert.deepEqual(s.renderers, [p], 'removed output stops receiving input immediately');
    assert.ok(oldSecondary.destroyed);
    assert.equal(secondary.handlers.size, 0);
    s.flush();
    assert.equal(s.built.length, 2);
    const replacement = monitor('DP-2', 1920, 1.5);
    s.monitors.replace([primary, replacement]);
    s.flush();
    assert.equal(s.renderers[0], p);
    assert.equal(s.renderers[1].instanceId, oldSecondary.instanceId);
    assert.notEqual(s.renderers[1], oldSecondary);
    s.manager.destroy();
    assert.equal(s.app.holds, 0);
    assert.equal(primary.handlers.size + replacement.handlers.size + s.monitors.handlers.size, 0);
});

test('batch geometry, scaling and refresh changes and rebuild only the changed monitor', () => {
    const primary = monitor('DP-1');
    const secondary = monitor('DP-2', 1920);
    const s = setup([primary, secondary]);
    const [p, oldSecondary] = s.renderers;
    secondary.change('geometry', {...secondary.geometry, width: 2560});
    secondary.change('scale', 1.5);
    secondary.refresh = 144000;
    secondary.emit('notify', {name: 'refresh-rate'});
    assert.equal(s.timers.size, 1);
    s.flush();
    assert.equal(s.built.length, 3);
    assert.equal(s.renderers[0], p);
    assert.ok(oldSecondary.destroyed);
    const current = s.renderers[1];
    secondary.emit('notify', {name: 'scale'});
    s.flush();
    assert.equal(s.renderers[1], current, 'unchanged notifications do not restart playback');
    s.manager.destroy();
});

test('monitor invalidation and temporarily having no outputs keep the process alive', () => {
    const primary = monitor('DP-1');
    const s = setup([primary]);
    primary.change('valid', false);
    assert.equal(s.renderers.length, 0);
    assert.equal(primary.handlers.size, 0);
    s.monitors.replace([]);
    s.flush();
    assert.equal(s.app.holds, 1);
    s.monitors.replace([monitor('DP-1')]);
    s.flush();
    assert.equal(s.renderers.length, 1);
    s.manager.destroy();
});

test('reindexing preserves physical identity and shutdown cancels a pending update', () => {
    const primary = monitor('DP-1');
    const secondary = monitor('DP-2', 1920);
    const s = setup([primary, secondary]);
    const oldSecondary = s.renderers[1];
    s.monitors.replace([secondary]);
    s.flush();
    assert.equal(s.renderers[0], oldSecondary);
    assert.equal(oldSecondary._index, 0);
    assert.equal(oldSecondary.instanceId, 'stable:DP-2');
    secondary.change('scale', 2);
    assert.equal(s.timers.size, 1);
    s.manager.destroy();
    assert.equal(s.timers.size, 0);
    assert.equal(s.renderers.length, 0);
    assert.ok(oldSecondary.destroyed);
    assert.equal(s.app.holds, 0);
});

test('startup without outputs and rapid reconnects never resurrect removed monitors', () => {
    const s = setup([]);
    assert.equal(s.app.holds, 1);
    assert.equal(s.renderers.length, 0);
    const primary = monitor('DP-1');
    const secondary = monitor('DP-2', 1920);
    s.monitors.replace([primary, secondary]);
    s.monitors.replace([primary]);
    s.flush();
    assert.equal(s.built.length, 1);
    assert.equal(s.renderers[0].instanceId, 'stable:DP-1');
    assert.equal(secondary.handlers.size, 0);
    s.manager.destroy();
});
