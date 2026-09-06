// Keeps the renderer's MetaWindow minimized / at-bottom / positioned so it
// never paints on top while its wl_surface keeps committing for the
// Clutter.Clone. Driven by JSON state in the window title:
//   @<APP_ID>!<json>|<monitor_index>

import GLib from 'gi://GLib';

import * as Wallpaper from './wallpaper.js';

const APPLICATION_ID = Wallpaper.APPLICATION_ID;
const TITLE_PREFIX = `@${APPLICATION_ID}!`;

class ManagedWindow {
    constructor(window, launcher) {
        this._window = window;
        this._launcher = launcher;
        this._signals = [];
        this._lowerIdleId = 0;
        this._states = {
            keepAtBottom: false,
            keepMinimized: false,
            keepPosition: false,
            position: [0, 0],
        };

        this._signals.push(window.connect('notify::title',
            () => this._parseTitle()));

        // Any raise (focus, alt-tab, etc.) → lower immediately.
        this._signals.push(window.connect_after('raised', () => {
            if (this._states.keepAtBottom)
                this._window.lower();
        }));

        // Some shells try to promote our window to "above"; revert.
        this._signals.push(window.connect('notify::above', () => {
            if (this._states.keepAtBottom && this._window.above)
                this._window.unmake_above();
        }));

        // If anything unminimizes us, snap back immediately.
        this._signals.push(window.connect('notify::minimized', () => {
            if (this._states.keepMinimized && !this._window.minimized)
                this._minimize();
        }));

        this._signals.push(window.connect('position-changed', () => {
            if (this._states.keepPosition) {
                const [x, y] = this._states.position;
                this._window.move_frame(true, x, y);
            }
        }));

        this._parseTitle();
    }

    _parseTitle() {
        const title = this._window?.title;
        if (!title || !title.startsWith(TITLE_PREFIX))
            return;
        // Title: @<APP_ID>!<json>|<idx>
        const after = title.slice(TITLE_PREFIX.length);
        const pipe = after.indexOf('|');
        const jsonStr = pipe >= 0 ? after.slice(0, pipe) : after;
        try {
            const parsed = JSON.parse(jsonStr);
            this._states = {...this._states, ...parsed};
        } catch (_e) {
            // Malformed title from the renderer; keep previous state.
        }
        this._refresh();
    }

    _refresh() {
        if (!this._window)
            return;
        if (this._states.keepAtBottom && this._window.above)
            this._window.unmake_above();
        if (this._states.keepMinimized && !this._window.minimized) {
            this._minimize();
        } else if (this._states.keepAtBottom && !this._window.minimized &&
                   !this._lowerIdleId) {
            // Defer to idle: lower() before mutter assigns a stack position
            // trips a set_stack_position_no_sync CRITICAL.
            this._lowerIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._lowerIdleId = 0;
                try { this._window?.lower(); } catch (_e) {}
                return GLib.SOURCE_REMOVE;
            });
        }
        if (this._states.keepPosition) {
            const [x, y] = this._states.position;
            this._window.move_frame(true, x, y);
        }
    }

    _minimize() {
        // Mutter cannot minimize skip-taskbar windows. Clear the exclusion
        // temporarily and restore it before the queued visibility update.
        const wasSkipped = this._window.skip_taskbar;
        if (wasSkipped)
            this._launcher?.setWindowListVisible(this._window, true);
        try {
            this._window.minimize();
        } finally {
            if (wasSkipped)
                this._launcher?.setWindowListVisible(this._window, false);
        }
    }

    disconnect() {
        if (this._lowerIdleId) {
            GLib.source_remove(this._lowerIdleId);
            this._lowerIdleId = 0;
        }
        if (!this._window)
            return;
        for (const id of this._signals) {
            try { this._window.disconnect(id); } catch (_e) {}
        }
        this._signals = [];
        this._window = null;
        this._launcher = null;
    }
}

export class WindowManager {
    constructor() {
        this._managed = new Map();   // MetaWindow -> ManagedWindow
        this._mapId = 0;
        // Used to verify window ownership via Meta.WaylandClient.owns_window.
        this._launcher = null;
    }

    setLauncher(launcher) {
        this._launcher = launcher;
    }

    enable() {
        this._mapId = global.window_manager.connect_after('map',
            (_wm, actor) => this._onMap(actor));
    }

    _onMap(actor) {
        const win = actor.get_meta_window?.();
        if (!win)
            return;
        // Two acceptance gates, either suffices: title match (cheap)
        // or wayland-client ownership (authoritative).
        const titleOk = win.title?.startsWith(TITLE_PREFIX);
        const ownsOk = this._launcher?.ownsWindow?.(win);
        if (!titleOk && !ownsOk)
            return;
        if (this._managed.has(win))
            return;
        const mw = new ManagedWindow(win, this._launcher);
        // Minimize first: setting the native exclusion disables minimizing.
        this._launcher?.setWindowListVisible(win, false);
        this._managed.set(win, mw);
        // Drop tracking when mutter releases the MetaWindow.
        const unId = win.connect('unmanaged', () => {
            const entry = this._managed.get(win);
            if (entry) {
                entry.disconnect();
                this._managed.delete(win);
            }
            try { win.disconnect(unId); } catch (_e) {}
        });
    }

    disable() {
        if (this._mapId) {
            global.window_manager.disconnect(this._mapId);
            this._mapId = 0;
        }
        for (const mw of this._managed.values())
            mw.disconnect();
        this._managed.clear();
        this._launcher = null;
    }
}
