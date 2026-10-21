import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('blur cleanup tolerates effects already removed by native actor destruction', () => {
    const source = readFileSync(new URL('../extension/blur.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const BlurController = vm.runInNewContext(`${source}\nBlurController`, {
        Shell: {BlurMode: {}, BlurEffect: class {
            set_enabled() {}
            get_actor() { return this.actor; }
        }},
    });
    let attached = null;
    let removals = 0;
    const actor = {
        add_effect_with_name(_name, effect) { attached = effect; effect.actor = this; },
        remove_effect(effect) {
            removals++;
            assert.equal(effect.actor, this, 'cannot remove an effect detached by GNOME');
            effect.actor = null;
            attached = null;
        },
    };
    const blur = new BlurController(actor, 'test-blur');
    blur.setState(true, true, 30);
    blur.setState(false, false, 30);
    assert.equal(removals, 1);
    blur.setState(true, true, 30);
    attached.actor = null; // Native disposal clears ownership before its effect list.
    blur.destroy();
    assert.equal(removals, 1);
    blur.destroy();
    assert.equal(blur._actor, null);
});
