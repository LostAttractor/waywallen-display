import assert from 'node:assert/strict';

export class Signals {
    handlers = new Map();
    nextId = 1;
    connect(name, callback) {
        assert.ok(!this.disposed, 'connected disposed object');
        const id = this.nextId++;
        this.handlers.set(id, {name, callback});
        return id;
    }
    connect_after(name, callback) { return this.connect(name, callback); }
    disconnect(id) { assert.ok(this.handlers.delete(id), 'disconnected unknown signal'); }
    emit(name, ...args) {
        for (const [id, handler] of [...this.handlers]) {
            if (this.handlers.has(id) && handler.name === name)
                handler.callback(this, ...args);
        }
    }
}

export class Actor extends Signals {
    children = new Set();
    constructor(...args) { super(); this._init(...args); }
    _init(props) { Object.assign(this, props); }
    get_parent() { assert.ok(!this.disposed, 'accessed disposed actor'); return this.parent ?? null; }
    get_children() { return [...this.children]; }
    add_child(child) {
        assert.ok(!child.parent, 'child already has a parent');
        this.children.add(child);
        child.parent = this;
        this.emit('child-added', child);
    }
    remove_child(child) {
        assert.ok(this.children.delete(child));
        child.parent = null;
        this.emit('child-removed', child);
    }
    set_style() {}
    set_child_below_sibling() {}
    set_child_above_sibling() {}
    set_position(x, y) { Object.assign(this, {x, y}); }
    set_scale(scale_x, scale_y) { Object.assign(this, {scale_x, scale_y}); }
    easeCalls = [];
    ease(props) {
        assert.ok(!this.disposed);
        this.easeCalls.push({from: this.opacity, ...props});
        this.opacity = props.opacity;
    }
    remove_all_transitions() { assert.ok(!this.disposed); }
    destroy() {
        assert.ok(!this.disposed, 'actor destroyed twice');
        this.destroying = true;
        this.emit('destroy');
        if (this.on_destroy)
            this.on_destroy();
        else
            for (const child of [...this.children]) child.destroy();
        this.parent?.remove_child(this);
        this.handlers.clear();
        this.disposed = true;
    }
}
