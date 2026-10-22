import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function setup() {
    class Launcher {
        running = false;
        sent = [];
        cancellable = {cancel() {}};
        subprocess = {wait_async: (_cancel, callback) => { this.exited = callback; },
            wait_finish() {}, send_signal() {}};
        setControlHandler(handler) { this.control = handler; }
        set_cwd() {}
        set_env() {}
        prepend_env() {}
        spawnv() { this.running = true; }
        writeStdin(line) { this.sent.push(line); }
    }
    const presentations = new Map();
    const resets = [];
    const override = {
        available: false,
        setRendererAvailable(value) { this.available = value; },
        setRendererLauncher(launcher) { this.launcher = launcher; },
        resetPresentation() { presentations.clear(); },
        applyControlFrame(frame) {
            const key = `${frame.geometry.x},${frame.geometry.y}`;
            if (frame.type === 'reset') presentations.delete(key);
            else presentations.set(key, frame.presentation);
            return true;
        },
    };
    const source = readFileSync(new URL('../extension/extension.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export default class', 'class');
    const Extension = vm.runInNewContext(`${source}\nWaywallenExtension`, {
        Extension: class {}, LaunchSubprocess: Launcher, log() {},
        GLib: {get_monotonic_time: () => 1, get_home_dir: () => '/tmp',
            build_filenamev: parts => parts.join('/'), file_test: () => false,
            FileTest: {IS_DIR: 1}, source_remove() {}},
    });
    const extension = new Extension();
    Object.assign(extension, {_isEnabled: true, _daemonUp: true, path: '/extension',
        _settings: {get_string: () => '', get_boolean: () => false},
        _override: override, _winState: {setLauncher() {}, resetConfig: geometry => resets.push(geometry)}});
    extension._spawnRenderer();
    return {extension, proc: extension._currentProc, override, presentations, resets};
}

function connection(x) {
    return {type: 'connection', geometry: {x, y: 0, width: 1920, height: 1080},
        presentation: {config: {generation: 1}}};
}

test('resetting one output leaves the surviving renderer process available', () => {
    const s = setup();
    const primary = connection(0);
    const secondary = connection(1920);
    s.proc.control(primary);
    s.proc.control(secondary);
    assert.equal(s.override.available, true);
    s.proc.control({type: 'reset', geometry: secondary.geometry});
    assert.equal(s.override.available, true, 'one display reset must not hide every wallpaper');
    assert.equal(s.presentations.get('0,0'), primary.presentation);
    assert.equal(s.presentations.has('1920,0'), false);
    assert.equal(s.resets.length, 1);
    s.proc.control({type: 'reset', geometry: primary.geometry});
    assert.equal(s.presentations.size, 0);
    s.proc.control(primary);
    assert.equal(s.override.available, true);
    assert.equal(s.presentations.get('0,0'), primary.presentation);
});

test('daemon loss still invalidates the whole process and ignores late frames', () => {
    const s = setup();
    s.proc.control(connection(0));
    s.extension._onDaemonVanished();
    assert.equal(s.override.available, false);
    assert.equal(s.override.launcher, null);
    assert.equal(s.presentations.size, 0);
    s.proc.control(connection(1920));
    assert.equal(s.override.available, false);
    assert.equal(s.presentations.size, 0);
});

test('renderer exit invalidates all outputs without accepting stale callbacks', () => {
    const s = setup();
    s.proc.control(connection(0));
    s.extension._isEnabled = false;
    s.proc.exited(s.proc.subprocess, {});
    assert.equal(s.override.available, false);
    assert.equal(s.override.launcher, null);
    assert.equal(s.presentations.size, 0);
    s.proc.control(connection(0));
    assert.equal(s.override.available, false);
});
