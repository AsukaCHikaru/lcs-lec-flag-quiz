var app = (function () {
    'use strict';

    function noop() { }
    function run(fn) {
        return fn();
    }
    function blank_object() {
        return Object.create(null);
    }
    function run_all(fns) {
        fns.forEach(run);
    }
    function is_function(thing) {
        return typeof thing === 'function';
    }
    function safe_not_equal(a, b) {
        return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
    }
    function is_empty(obj) {
        return Object.keys(obj).length === 0;
    }

    // Track which nodes are claimed during hydration. Unclaimed nodes can then be removed from the DOM
    // at the end of hydration without touching the remaining nodes.
    let is_hydrating = false;
    function start_hydrating() {
        is_hydrating = true;
    }
    function end_hydrating() {
        is_hydrating = false;
    }
    function upper_bound(low, high, key, value) {
        // Return first index of value larger than input value in the range [low, high)
        while (low < high) {
            const mid = low + ((high - low) >> 1);
            if (key(mid) <= value) {
                low = mid + 1;
            }
            else {
                high = mid;
            }
        }
        return low;
    }
    function init_hydrate(target) {
        if (target.hydrate_init)
            return;
        target.hydrate_init = true;
        // We know that all children have claim_order values since the unclaimed have been detached
        const children = target.childNodes;
        /*
        * Reorder claimed children optimally.
        * We can reorder claimed children optimally by finding the longest subsequence of
        * nodes that are already claimed in order and only moving the rest. The longest
        * subsequence subsequence of nodes that are claimed in order can be found by
        * computing the longest increasing subsequence of .claim_order values.
        *
        * This algorithm is optimal in generating the least amount of reorder operations
        * possible.
        *
        * Proof:
        * We know that, given a set of reordering operations, the nodes that do not move
        * always form an increasing subsequence, since they do not move among each other
        * meaning that they must be already ordered among each other. Thus, the maximal
        * set of nodes that do not move form a longest increasing subsequence.
        */
        // Compute longest increasing subsequence
        // m: subsequence length j => index k of smallest value that ends an increasing subsequence of length j
        const m = new Int32Array(children.length + 1);
        // Predecessor indices + 1
        const p = new Int32Array(children.length);
        m[0] = -1;
        let longest = 0;
        for (let i = 0; i < children.length; i++) {
            const current = children[i].claim_order;
            // Find the largest subsequence length such that it ends in a value less than our current value
            // upper_bound returns first greater value, so we subtract one
            const seqLen = upper_bound(1, longest + 1, idx => children[m[idx]].claim_order, current) - 1;
            p[i] = m[seqLen] + 1;
            const newLen = seqLen + 1;
            // We can guarantee that current is the smallest value. Otherwise, we would have generated a longer sequence.
            m[newLen] = i;
            longest = Math.max(newLen, longest);
        }
        // The longest increasing subsequence of nodes (initially reversed)
        const lis = [];
        // The rest of the nodes, nodes that will be moved
        const toMove = [];
        let last = children.length - 1;
        for (let cur = m[longest] + 1; cur != 0; cur = p[cur - 1]) {
            lis.push(children[cur - 1]);
            for (; last >= cur; last--) {
                toMove.push(children[last]);
            }
            last--;
        }
        for (; last >= 0; last--) {
            toMove.push(children[last]);
        }
        lis.reverse();
        // We sort the nodes being moved to guarantee that their insertion order matches the claim order
        toMove.sort((a, b) => a.claim_order - b.claim_order);
        // Finally, we move the nodes
        for (let i = 0, j = 0; i < toMove.length; i++) {
            while (j < lis.length && toMove[i].claim_order >= lis[j].claim_order) {
                j++;
            }
            const anchor = j < lis.length ? lis[j] : null;
            target.insertBefore(toMove[i], anchor);
        }
    }
    function append(target, node) {
        if (is_hydrating) {
            init_hydrate(target);
            if ((target.actual_end_child === undefined) || ((target.actual_end_child !== null) && (target.actual_end_child.parentElement !== target))) {
                target.actual_end_child = target.firstChild;
            }
            if (node !== target.actual_end_child) {
                target.insertBefore(node, target.actual_end_child);
            }
            else {
                target.actual_end_child = node.nextSibling;
            }
        }
        else if (node.parentNode !== target) {
            target.appendChild(node);
        }
    }
    function insert(target, node, anchor) {
        if (is_hydrating && !anchor) {
            append(target, node);
        }
        else if (node.parentNode !== target || (anchor && node.nextSibling !== anchor)) {
            target.insertBefore(node, anchor || null);
        }
    }
    function detach(node) {
        node.parentNode.removeChild(node);
    }
    function element(name) {
        return document.createElement(name);
    }
    function svg_element(name) {
        return document.createElementNS('http://www.w3.org/2000/svg', name);
    }
    function text(data) {
        return document.createTextNode(data);
    }
    function space() {
        return text(' ');
    }
    function empty() {
        return text('');
    }
    function listen(node, event, handler, options) {
        node.addEventListener(event, handler, options);
        return () => node.removeEventListener(event, handler, options);
    }
    function attr(node, attribute, value) {
        if (value == null)
            node.removeAttribute(attribute);
        else if (node.getAttribute(attribute) !== value)
            node.setAttribute(attribute, value);
    }
    function children(element) {
        return Array.from(element.childNodes);
    }
    function set_data(text, data) {
        data = '' + data;
        if (text.wholeText !== data)
            text.data = data;
    }
    function set_input_value(input, value) {
        input.value = value == null ? '' : value;
    }

    let current_component;
    function set_current_component(component) {
        current_component = component;
    }
    function get_current_component() {
        if (!current_component)
            throw new Error('Function called outside component initialization');
        return current_component;
    }
    function onMount(fn) {
        get_current_component().$$.on_mount.push(fn);
    }

    const dirty_components = [];
    const binding_callbacks = [];
    const render_callbacks = [];
    const flush_callbacks = [];
    const resolved_promise = Promise.resolve();
    let update_scheduled = false;
    function schedule_update() {
        if (!update_scheduled) {
            update_scheduled = true;
            resolved_promise.then(flush);
        }
    }
    function add_render_callback(fn) {
        render_callbacks.push(fn);
    }
    let flushing = false;
    const seen_callbacks = new Set();
    function flush() {
        if (flushing)
            return;
        flushing = true;
        do {
            // first, call beforeUpdate functions
            // and update components
            for (let i = 0; i < dirty_components.length; i += 1) {
                const component = dirty_components[i];
                set_current_component(component);
                update(component.$$);
            }
            set_current_component(null);
            dirty_components.length = 0;
            while (binding_callbacks.length)
                binding_callbacks.pop()();
            // then, once components are updated, call
            // afterUpdate functions. This may cause
            // subsequent updates...
            for (let i = 0; i < render_callbacks.length; i += 1) {
                const callback = render_callbacks[i];
                if (!seen_callbacks.has(callback)) {
                    // ...so guard against infinite loops
                    seen_callbacks.add(callback);
                    callback();
                }
            }
            render_callbacks.length = 0;
        } while (dirty_components.length);
        while (flush_callbacks.length) {
            flush_callbacks.pop()();
        }
        update_scheduled = false;
        flushing = false;
        seen_callbacks.clear();
    }
    function update($$) {
        if ($$.fragment !== null) {
            $$.update();
            run_all($$.before_update);
            const dirty = $$.dirty;
            $$.dirty = [-1];
            $$.fragment && $$.fragment.p($$.ctx, dirty);
            $$.after_update.forEach(add_render_callback);
        }
    }
    const outroing = new Set();
    let outros;
    function group_outros() {
        outros = {
            r: 0,
            c: [],
            p: outros // parent group
        };
    }
    function check_outros() {
        if (!outros.r) {
            run_all(outros.c);
        }
        outros = outros.p;
    }
    function transition_in(block, local) {
        if (block && block.i) {
            outroing.delete(block);
            block.i(local);
        }
    }
    function transition_out(block, local, detach, callback) {
        if (block && block.o) {
            if (outroing.has(block))
                return;
            outroing.add(block);
            outros.c.push(() => {
                outroing.delete(block);
                if (callback) {
                    if (detach)
                        block.d(1);
                    callback();
                }
            });
            block.o(local);
        }
    }
    function create_component(block) {
        block && block.c();
    }
    function mount_component(component, target, anchor, customElement) {
        const { fragment, on_mount, on_destroy, after_update } = component.$$;
        fragment && fragment.m(target, anchor);
        if (!customElement) {
            // onMount happens before the initial afterUpdate
            add_render_callback(() => {
                const new_on_destroy = on_mount.map(run).filter(is_function);
                if (on_destroy) {
                    on_destroy.push(...new_on_destroy);
                }
                else {
                    // Edge case - component was destroyed immediately,
                    // most likely as a result of a binding initialising
                    run_all(new_on_destroy);
                }
                component.$$.on_mount = [];
            });
        }
        after_update.forEach(add_render_callback);
    }
    function destroy_component(component, detaching) {
        const $$ = component.$$;
        if ($$.fragment !== null) {
            run_all($$.on_destroy);
            $$.fragment && $$.fragment.d(detaching);
            // TODO null out other refs, including component.$$ (but need to
            // preserve final state?)
            $$.on_destroy = $$.fragment = null;
            $$.ctx = [];
        }
    }
    function make_dirty(component, i) {
        if (component.$$.dirty[0] === -1) {
            dirty_components.push(component);
            schedule_update();
            component.$$.dirty.fill(0);
        }
        component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
    }
    function init(component, options, instance, create_fragment, not_equal, props, dirty = [-1]) {
        const parent_component = current_component;
        set_current_component(component);
        const $$ = component.$$ = {
            fragment: null,
            ctx: null,
            // state
            props,
            update: noop,
            not_equal,
            bound: blank_object(),
            // lifecycle
            on_mount: [],
            on_destroy: [],
            on_disconnect: [],
            before_update: [],
            after_update: [],
            context: new Map(parent_component ? parent_component.$$.context : options.context || []),
            // everything else
            callbacks: blank_object(),
            dirty,
            skip_bound: false
        };
        let ready = false;
        $$.ctx = instance
            ? instance(component, options.props || {}, (i, ret, ...rest) => {
                const value = rest.length ? rest[0] : ret;
                if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                    if (!$$.skip_bound && $$.bound[i])
                        $$.bound[i](value);
                    if (ready)
                        make_dirty(component, i);
                }
                return ret;
            })
            : [];
        $$.update();
        ready = true;
        run_all($$.before_update);
        // `false` as a special case of no DOM component
        $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
        if (options.target) {
            if (options.hydrate) {
                start_hydrating();
                const nodes = children(options.target);
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.l(nodes);
                nodes.forEach(detach);
            }
            else {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.c();
            }
            if (options.intro)
                transition_in(component.$$.fragment);
            mount_component(component, options.target, options.anchor, options.customElement);
            end_hydrating();
            flush();
        }
        set_current_component(parent_component);
    }
    /**
     * Base class for Svelte components. Used when dev=false.
     */
    class SvelteComponent {
        $destroy() {
            destroy_component(this, 1);
            this.$destroy = noop;
        }
        $on(type, callback) {
            const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
            callbacks.push(callback);
            return () => {
                const index = callbacks.indexOf(callback);
                if (index !== -1)
                    callbacks.splice(index, 1);
            };
        }
        $set($$props) {
            if (this.$$set && !is_empty($$props)) {
                this.$$.skip_bound = true;
                this.$$set($$props);
                this.$$.skip_bound = false;
            }
        }
    }

    /* src/components/Title.svelte generated by Svelte v3.38.3 */

    function add_css$8() {
    	var style = element("style");
    	style.id = "svelte-159jh08-style";
    	style.textContent = ".title-wrapper.svelte-159jh08{text-align:center;margin-bottom:5em}h4.svelte-159jh08{font-weight:300}";
    	append(document.head, style);
    }

    function create_fragment$9(ctx) {
    	let div;

    	return {
    		c() {
    			div = element("div");

    			div.innerHTML = `<h1 class="title">LCS LEC TEAM QUIZ</h1> 
  <h4 class="svelte-159jh08">Inspired by <a href="https://www.youtube.com/watch?v=W-bWki07A4g" rel="noreferrer nopener" target="_blank">LEC POP QUIZ: Guess the Team</a></h4>`;

    			attr(div, "class", "title-wrapper svelte-159jh08");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    		},
    		p: noop,
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(div);
    		}
    	};
    }

    class Title extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-159jh08-style")) add_css$8();
    		init(this, options, null, create_fragment$9, safe_not_equal, {});
    	}
    }

    const players = {
      TOP: {
        Dyrus: {
          ign: 'Dyrus',
          position: 'TOP',
          nationality: 'US',
        },
        Hauntzer: {
          ign: 'Hauntzer',
          position: 'TOP',
          nationality: 'US',
        },
        BrokenBlade: {
          ign: 'BrokenBlade',
          position: 'TOP',
          nationality: 'DE',
        },
        Impact: {
          ign: 'Impact',
          position: 'TOP',
          nationality: 'KR',
        },
        Licorice: {
          ign: 'Licorice',
          position: 'TOP',
          nationality: 'CA',
        },
        Fudge: {
          ign: 'Fudge',
          position: 'TOP',
          nationality: 'AU',
        },
        Alphari: {
          ign: 'Alphari',
          position: 'TOP',
          nationality: 'GB',
        },
        sOAZ: {
          ign: 'sOAZ',
          position: 'TOP',
          nationality: 'FR',
        },
        Huni: {
          ign: 'Huni',
          position: 'TOP',
          nationality: 'KR',
        },
        Bwipo: {
          ign: 'Bwipo',
          position: 'TOP',
          nationality: 'BE',
        },
        Kikis: {
          ign: 'Kikis',
          position: 'TOP',
          nationality: 'PL',
        },
        Wunder: {
          ign: 'Wunder',
          position: 'TOP',
          nationality: 'DK',
        },
      },
      JG: {
        TheOddOne: {
          ign: 'TheOddOne',
          position: 'JG',
          nationality: 'CA',
        },
        Amazing: {
          ign: 'Amazing',
          position: 'JG',
          nationality: 'DE',
        },
        Svenskeren: {
          ign: 'Svenskeren',
          position: 'JG',
          nationality: 'DK',
        },
        Grig: {
          ign: 'Grig',
          position: 'JG',
          nationality: 'US',
        },
        Spica: {
          ign: 'Spica',
          position: 'JG',
          nationality: 'CN',
        },
        Xmithie: {
          ign: 'Xmithie',
          position: 'JG',
          nationality: 'PH',
        },
        Santorin: {
          ign: 'Santorin',
          position: 'JG',
          nationality: 'DK',
        },
        Blaber: {
          ign: 'Blaber',
          position: 'JG',
          nationality: 'US',
        },
        Cyanide: {
          ign: 'Cyanide',
          position: 'JG',
          nationality: 'FI',
        },
        Reignover: {
          ign: 'Reignover',
          position: 'JG',
          nationality: 'KR',
        },
        Broxah: {
          ign: 'Broxah',
          position: 'JG',
          nationality: 'DK',
        },
        Selfmade: {
          ign: 'Selfmade',
          position: 'JG',
          nationality: 'PL',
        },
        Jankos: {
          ign: 'Jankos',
          position: 'JG',
          nationality: 'PL',
        },
        Trick: {
          ign: 'Trick',
          position: 'JG',
          nationality: 'PL',
        },
      },
      MID: {
        Reginald: {
          ign: 'Reginald',
          position: 'MID',
          nationality: 'US',
        },
        Bjergsen: {
          ign: 'Bjergsen',
          position: 'MID',
          nationality: 'DK',
        },
        PowerOfEvil: {
          ign: 'PowerOfEvil',
          position: 'MID',
          nationality: 'DE',
        },
        Jensen: {
          ign: 'Jensen',
          position: 'MID',
          nationality: 'DK',
        },
        Perkz: {
          ign: 'Perkz',
          position: 'MID',
          nationality: 'HR',
        },
        XPeke: {
          ign: 'XPeke',
          position: 'MID',
          nationality: 'ES',
        },
        Febiven: {
          ign: 'Febiven',
          position: 'MID',
          nationality: 'NL',
        },
        Caps: {
          ign: 'Caps',
          position: 'MID',
          nationality: 'DK',
        },
        Nemesis: {
          ign: 'Nemesis',
          position: 'MID',
          nationality: 'SI',
        },
      },
      BOT: {
        Chaox: {
          ign: 'Chaox',
          position: 'BOT',
          nationality: 'CN',
        },
        WildTurtle: {
          ign: 'WildTurtle',
          position: 'BOT',
          nationality: 'CA',
        },
        Doublelift: {
          ign: 'Doublelift',
          position: 'BOT',
          nationality: 'US',
        },
        Zven: {
          ign: 'Zven',
          position: 'BOT',
          nationality: 'DK',
        },
        Lost: {
          ign: 'Lost',
          position: 'BOT',
          nationality: 'NZ',
        },
        Tactical: {
          ign: 'Tactical',
          position: 'BOT',
          nationality: 'US',
        },
        Sneaky: {
          ign: 'Sneaky',
          position: 'BOT',
          nationality: 'US',
        },
        YellOwStaR: {
          ign: 'YellOwStaR',
          position: 'BOT',
          nationality: 'FR',
        },
        Steelback: {
          ign: 'Steelback',
          position: 'BOT',
          nationality: 'FR',
        },
        Rekkles: {
          ign: 'Rekkles',
          position: 'BOT',
          nationality: 'SE',
        },
        Emperor: {
          ign: 'Emperor',
          position: 'BOT',
          nationality: 'KR',
        },
        Hjarnan: {
          ign: 'Hjarnan',
          position: 'BOT',
          nationality: 'SE',
        },
        Perkz: {
          ign: 'Perkz',
          position: 'BOT',
          nationality: 'HR',
        },
      },
      SPT: {
        Xpecial: {
          ign: 'Xpecial',
          position: 'SPT',
          nationality: 'CA',
        },
        Lustboy: {
          ign: 'Lustboy',
          position: 'SPT',
          nationality: 'KR',
        },
        Biofrost: {
          ign: 'Biofrost',
          position: 'SPT',
          nationality: 'CA',
        },
        Mithy: {
          ign: 'Mithy',
          position: 'SPT',
          nationality: 'ES',
        },
        Treatz: {
          ign: 'Treatz',
          position: 'SPT',
          nationality: 'SE',
        },
        SwordArt: {
          ign: 'SwordArt',
          position: 'SPT',
          nationality: 'TW',
        },
        CoreJJ: {
          ign: 'CoreJJ',
          position: 'SPT',
          nationality: 'KR',
        },
        Zeyzal: {
          ign: 'Zeyzal',
          position: 'SPT',
          nationality: 'US',
        },
        Vulcan: {
          ign: 'Vulcan',
          position: 'SPT',
          nationality: 'CA',
        },
        NRated: {
          ign: 'NRated',
          position: 'SPT',
          nationality: 'DE',
        },
        YellOwStaR: {
          ign: 'YellOwStaR',
          position: 'SPT',
          nationality: 'FR',
        },
        Hylissang: {
          ign: 'Hylissang',
          position: 'SPT',
          nationality: 'BG',
        },
        Hybrid: {
          ign: 'Hybrid',
          position: 'SPT',
          nationality: 'NL',
        },
        Wadid: {
          ign: 'Wadid',
          position: 'SPT',
          nationality: 'KR',
        },
        Mikyx: {
          ign: 'Mikyx',
          position: 'SPT',
          nationality: 'SI',
        },
      },
    };

    const teams = {
      TSM: {
        name: ["Team Solo Mid"],
        abbr: "TSM",
        region: "NA",
      },
      TL: {
        name: ["Team Liquid", "liquid"],
        abbr: "TL",
        region: "NA",
      },
      C9: {
        name: ["Cloud 9", "cloud nine"],
        abbr: "C9",
        region: "NA",
      },
      FNC: {
        name: ["Fnatic"],
        abbr: "FNC",
        region: "EU",
      },
      G2: {
        name: ["G2 Esports"],
        abbr: "G2",
        region: "EU",
      },
    };

    const data = [
        {
          team: teams.TSM,
          year: '2013',
          split: 'spring',
          region: "NA",
          players: {
            TOP: players.TOP.Dyrus,
            JG: players.JG.TheOddOne,
            MID: players.MID.Reginald,
            BOT: players.BOT.Chaox,
            SPT: players.SPT.Xpecial,
          },
        },
        {
          team: teams.TSM,
          year: '2013',
          split: 'summer',
          region: "NA",
          players: {
            TOP: players.TOP.Dyrus,
            JG: players.JG.TheOddOne,
            MID: players.MID.Reginald,
            BOT: players.BOT.WildTurtle,
            SPT: players.SPT.Xpecial,
          },
        },
        {
          team: teams.TSM,
          year: '2014',
          split: 'spring',
          region: "NA",
          players: {
            TOP: players.TOP.Dyrus,
            JG: players.JG.TheOddOne,
            MID: players.MID.Bjergsen,
            BOT: players.BOT.WildTurtle,
            SPT: players.SPT.Xpecial,
          },
        },
        {
          team: teams.TSM,
          year: '2014',
          split: 'summer',
          region: "NA",
          players: {
            TOP: players.TOP.Dyrus,
            JG: players.JG.Amazing,
            MID: players.MID.Bjergsen,
            BOT: players.BOT.WildTurtle,
            SPT: players.SPT.Lustboy,
          },
        },
        {
          team: teams.TSM,
          year: '2016',
          split: 'summer',
          region: "NA",
          players: {
            TOP: players.TOP.Hauntzer,
            JG: players.JG.Svenskeren,
            MID: players.MID.Bjergsen,
            BOT: players.BOT.Doublelift,
            SPT: players.SPT.Biofrost,
          },
        },
        {
          team: teams.TSM,
          year: '2018',
          split: 'summer',
          region: "NA",
          players: {
            TOP: players.TOP.BrokenBlade,
            JG: players.JG.Grig,
            MID: players.MID.Bjergsen,
            BOT: players.BOT.Zven,
            SPT: players.SPT.Mithy,
          },
        },
        {
          team: teams.TSM,
          year: '2020',
          split: 'summer',
          region: "NA",
          players: {
            TOP: players.TOP.BrokenBlade,
            JG: players.JG.Spica,
            MID: players.MID.Bjergsen,
            BOT: players.BOT.Doublelift,
            SPT: players.SPT.Treatz,
          },
        },
        {
          team: teams.TSM,
          year: '2021',
          split: 'spring',
          region: "NA",
          players: {
            TOP: players.TOP.Huni,
            JG: players.JG.Spica,
            MID: players.MID.PowerOfEvil,
            BOT: players.BOT.Lost,
            SPT: players.SPT.SwordArt,
          },
        },
        {
          team: teams.TL,
          year: '2019',
          split: 'spring',
          region: 'NA',
          players: {
            TOP: players.TOP.Impact,
            JG: players.JG.Xmithie,
            MID: players.MID.Jensen,
            BOT: players.BOT.Doublelift,
            SPT: players.SPT.CoreJJ,
          },
        },
        {
          team: teams.TL,
          year: '2021',
          split: 'spring',
          region: 'NA',
          players: {
            TOP: players.TOP.Alphari,
            JG: players.JG.Santorin,
            MID: players.MID.Jensen,
            BOT: players.BOT.Tactical,
            SPT: players.SPT.CoreJJ,
          },
        },
        {
          team: teams.C9,
          year: '2018',
          split: 'summer',
          region: 'NA',
          players: {
            TOP: players.TOP.Licorice,
            JG: players.JG.Svenskeren,
            MID: players.MID.Jensen,
            BOT: players.BOT.Sneaky,
            SPT: players.SPT.Zeyzal,
          },
        },
        {
          team: teams.C9,
          year: '2021',
          split: 'spring',
          region: 'NA',
          players: {
            TOP: players.TOP.Fudge,
            JG: players.JG.Blaber,
            MID: players.MID.Perkz,
            BOT: players.BOT.Zven,
            SPT: players.SPT.Vulcan,
          },
        },
        {
          team: teams.FNC,
          year: '2013',
          split: 'spring',
          region: 'EU',
          players: {
            TOP: players.TOP.sOAZ,
            JG: players.JG.Cyanide,
            MID: players.MID.XPeke,
            BOT: players.BOT.YellOwStaR,
            SPT: players.SPT.NRated,
          },
        },
        {
          team: teams.FNC,
          year: '2015',
          split: 'spring',
          region: 'EU',
          players: {
            TOP: players.TOP.Huni,
            JG: players.JG.Reignover,
            MID: players.MID.Febiven,
            BOT: players.BOT.Steelback,
            SPT: players.SPT.YellOwStaR,
          },
        },
        {
          team: teams.FNC,
          year: '2018',
          split: 'spring',
          region: 'EU',
          players: {
            TOP: players.TOP.Bwipo,
            JG: players.JG.Broxah,
            MID: players.MID.Caps,
            BOT: players.BOT.Rekkles,
            SPT: players.SPT.Hylissang,
          },
        },
        {
          team: teams.FNC,
          year: '2020',
          split: 'spring',
          region: 'EU',
          players: {
            TOP: players.TOP.Bwipo,
            JG: players.JG.Selfmade,
            MID: players.MID.Nemesis,
            BOT: players.BOT.Rekkles,
            SPT: players.SPT.Hylissang,
          },
        },
        {
          team: teams.G2,
          year: '2016',
          split: 'spring',
          region: 'EU',
          players: {
            TOP: players.TOP.Kikis,
            JG: players.JG.Trick,
            MID: players.MID.Perkz,
            BOT: players.BOT.Emperor,
            SPT: players.SPT.Hybrid,
          },
        },
        {
          team: teams.G2,
          year: '2018',
          split: 'spring',
          region: 'EU',
          players: {
            TOP: players.TOP.Wunder,
            JG: players.JG.Jankos,
            MID: players.MID.Perkz,
            BOT: players.BOT.Hjarnan,
            SPT: players.SPT.Wadid,
          },
        },
        {
          team: teams.G2,
          year: '2019',
          split: 'spring',
          region: 'EU',
          players: {
            TOP: players.TOP.Wunder,
            JG: players.JG.Jankos,
            MID: players.MID.Caps,
            BOT: players.BOT.Perkz,
            SPT: players.SPT.Mikyx,
          },
        },
      ];

    const positionNameMap = {
      top: 'Top',
      jg: 'Jungle',
      mid: 'Mid',
      bot: 'Bot',
      spt: 'Support',
    };

    /* src/components/Player.svelte generated by Svelte v3.38.3 */

    function add_css$7() {
    	var style = element("style");
    	style.id = "svelte-sj2tlm-style";
    	style.textContent = ".player-wrapper.svelte-sj2tlm{margin:0 10px}h3.svelte-sj2tlm{text-align:center}.player-answer.svelte-sj2tlm{text-align:center}img.svelte-sj2tlm{width:100px}";
    	append(document.head, style);
    }

    function create_fragment$8(ctx) {
    	let div;
    	let h3;
    	let t0_value = positionNameMap[/*player*/ ctx[0].position.toLowerCase()] + "";
    	let t0;
    	let t1;
    	let img;
    	let img_src_value;
    	let img_alt_value;
    	let t2;
    	let h4;
    	let t3_value = (/*showAnswer*/ ctx[1] ? /*player*/ ctx[0].ign : "-") + "";
    	let t3;

    	return {
    		c() {
    			div = element("div");
    			h3 = element("h3");
    			t0 = text(t0_value);
    			t1 = space();
    			img = element("img");
    			t2 = space();
    			h4 = element("h4");
    			t3 = text(t3_value);
    			attr(h3, "class", "svelte-sj2tlm");
    			if (img.src !== (img_src_value = `assets/${/*player*/ ctx[0].nationality}.png`)) attr(img, "src", img_src_value);
    			attr(img, "alt", img_alt_value = /*player*/ ctx[0].nationality);
    			attr(img, "class", "svelte-sj2tlm");
    			attr(h4, "class", "player-answer svelte-sj2tlm");
    			attr(div, "class", "player-wrapper svelte-sj2tlm");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			append(div, h3);
    			append(h3, t0);
    			append(div, t1);
    			append(div, img);
    			append(div, t2);
    			append(div, h4);
    			append(h4, t3);
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*player*/ 1 && t0_value !== (t0_value = positionNameMap[/*player*/ ctx[0].position.toLowerCase()] + "")) set_data(t0, t0_value);

    			if (dirty & /*player*/ 1 && img.src !== (img_src_value = `assets/${/*player*/ ctx[0].nationality}.png`)) {
    				attr(img, "src", img_src_value);
    			}

    			if (dirty & /*player*/ 1 && img_alt_value !== (img_alt_value = /*player*/ ctx[0].nationality)) {
    				attr(img, "alt", img_alt_value);
    			}

    			if (dirty & /*showAnswer, player*/ 3 && t3_value !== (t3_value = (/*showAnswer*/ ctx[1] ? /*player*/ ctx[0].ign : "-") + "")) set_data(t3, t3_value);
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(div);
    		}
    	};
    }

    function instance$4($$self, $$props, $$invalidate) {
    	let { player } = $$props;
    	let { showAnswer } = $$props;

    	$$self.$$set = $$props => {
    		if ("player" in $$props) $$invalidate(0, player = $$props.player);
    		if ("showAnswer" in $$props) $$invalidate(1, showAnswer = $$props.showAnswer);
    	};

    	return [player, showAnswer];
    }

    class Player extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-sj2tlm-style")) add_css$7();
    		init(this, options, instance$4, create_fragment$8, safe_not_equal, { player: 0, showAnswer: 1 });
    	}
    }

    /* src/components/Input.svelte generated by Svelte v3.38.3 */

    function add_css$6() {
    	var style = element("style");
    	style.id = "svelte-1dpo3n2-style";
    	style.textContent = ".input-wrapper.svelte-1dpo3n2{display:flex;flex-direction:column;margin:10px}input.svelte-1dpo3n2{max-width:100px}";
    	append(document.head, style);
    }

    function create_fragment$7(ctx) {
    	let div;
    	let input;
    	let mounted;
    	let dispose;

    	return {
    		c() {
    			div = element("div");
    			input = element("input");
    			attr(input, "type", "text");
    			attr(input, "placeholder", /*question*/ ctx[1]);
    			attr(input, "class", "svelte-1dpo3n2");
    			attr(div, "class", "input-wrapper svelte-1dpo3n2");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			append(div, input);
    			set_input_value(input, /*value*/ ctx[0]);

    			if (!mounted) {
    				dispose = [
    					listen(input, "input", /*input_input_handler*/ ctx[6]),
    					listen(input, "input", /*handleInputChange*/ ctx[2]),
    					listen(input, "keyup", /*handleInputEnterPress*/ ctx[3])
    				];

    				mounted = true;
    			}
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*question*/ 2) {
    				attr(input, "placeholder", /*question*/ ctx[1]);
    			}

    			if (dirty & /*value*/ 1 && input.value !== /*value*/ ctx[0]) {
    				set_input_value(input, /*value*/ ctx[0]);
    			}
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(div);
    			mounted = false;
    			run_all(dispose);
    		}
    	};
    }

    function instance$3($$self, $$props, $$invalidate) {
    	let { question } = $$props;
    	let { onChange } = $$props;
    	let { onEnter } = $$props;
    	let { value } = $$props;

    	function handleInputChange(e) {
    		onChange(question.toLowerCase(), e.target.value);
    	}

    	function handleInputEnterPress(e) {
    		if (e.key !== "Enter") {
    			return;
    		}
    		onEnter(question.toLowerCase());
    	}

    	function input_input_handler() {
    		value = this.value;
    		$$invalidate(0, value);
    	}

    	$$self.$$set = $$props => {
    		if ("question" in $$props) $$invalidate(1, question = $$props.question);
    		if ("onChange" in $$props) $$invalidate(4, onChange = $$props.onChange);
    		if ("onEnter" in $$props) $$invalidate(5, onEnter = $$props.onEnter);
    		if ("value" in $$props) $$invalidate(0, value = $$props.value);
    	};

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty & /*value*/ 1) ;
    	};

    	return [
    		value,
    		question,
    		handleInputChange,
    		handleInputEnterPress,
    		onChange,
    		onEnter,
    		input_input_handler
    	];
    }

    class Input extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-1dpo3n2-style")) add_css$6();

    		init(this, options, instance$3, create_fragment$7, safe_not_equal, {
    			question: 1,
    			onChange: 4,
    			onEnter: 5,
    			value: 0
    		});
    	}
    }

    /* src/components/SkipButton.svelte generated by Svelte v3.38.3 */

    function add_css$5() {
    	var style = element("style");
    	style.id = "svelte-349j3i-style";
    	style.textContent = ".wrapper.svelte-349j3i{margin:1em}";
    	append(document.head, style);
    }

    function create_fragment$6(ctx) {
    	let div;
    	let button;
    	let mounted;
    	let dispose;

    	return {
    		c() {
    			div = element("div");
    			button = element("button");
    			button.textContent = "Skip";
    			attr(div, "class", "wrapper svelte-349j3i");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			append(div, button);

    			if (!mounted) {
    				dispose = listen(button, "click", /*handleButtonClick*/ ctx[0]);
    				mounted = true;
    			}
    		},
    		p: noop,
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(div);
    			mounted = false;
    			dispose();
    		}
    	};
    }

    function instance$2($$self, $$props, $$invalidate) {
    	let { onClick } = $$props;

    	function handleButtonClick() {
    		onClick();
    	}

    	$$self.$$set = $$props => {
    		if ("onClick" in $$props) $$invalidate(1, onClick = $$props.onClick);
    	};

    	return [handleButtonClick, onClick];
    }

    class SkipButton extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-349j3i-style")) add_css$5();
    		init(this, options, instance$2, create_fragment$6, safe_not_equal, { onClick: 1 });
    	}
    }

    /* src/components/Quiz.svelte generated by Svelte v3.38.3 */

    function add_css$4() {
    	var style = element("style");
    	style.id = "svelte-spsr4q-style";
    	style.textContent = ".quiz-container.svelte-spsr4q{display:flex;flex-direction:column;align-items:center;width:100%}.player-container.svelte-spsr4q{display:flex;flex-direction:row;justify-content:space-between;width:100%}.team-answer-container.svelte-spsr4q{display:flex;justify-content:center;text-align:center}.team-q-wrapper.svelte-spsr4q{width:100px;margin:10px 20px}.input-container.svelte-spsr4q{text-align:center}";
    	append(document.head, style);
    }

    // (76:2) {#if quiz}
    function create_if_block$1(ctx) {
    	let div0;
    	let player0;
    	let t0;
    	let player1;
    	let t1;
    	let player2;
    	let t2;
    	let player3;
    	let t3;
    	let player4;
    	let t4;
    	let div4;
    	let div1;
    	let h40;
    	let t6;
    	let h50;

    	let t7_value = (/*answerForm*/ ctx[1].team.correct
    	? /*quiz*/ ctx[0].team.abbr
    	: "-") + "";

    	let t7;
    	let t8;
    	let div2;
    	let h41;
    	let t10;
    	let h51;

    	let t11_value = (/*answerForm*/ ctx[1].year.correct
    	? /*quiz*/ ctx[0].year
    	: "-") + "";

    	let t11;
    	let t12;
    	let div3;
    	let h42;
    	let t14;
    	let h52;

    	let t15_value = (/*answerForm*/ ctx[1].split.correct
    	? /*quiz*/ ctx[0].split
    	: "-") + "";

    	let t15;
    	let t16;
    	let div5;
    	let input;
    	let current;

    	player0 = new Player({
    			props: {
    				player: /*quiz*/ ctx[0].players.TOP,
    				showAnswer: /*answerForm*/ ctx[1].top.correct
    			}
    		});

    	player1 = new Player({
    			props: {
    				player: /*quiz*/ ctx[0].players.JG,
    				showAnswer: /*answerForm*/ ctx[1].jungle.correct
    			}
    		});

    	player2 = new Player({
    			props: {
    				player: /*quiz*/ ctx[0].players.MID,
    				showAnswer: /*answerForm*/ ctx[1].mid.correct
    			}
    		});

    	player3 = new Player({
    			props: {
    				player: /*quiz*/ ctx[0].players.BOT,
    				showAnswer: /*answerForm*/ ctx[1].bot.correct
    			}
    		});

    	player4 = new Player({
    			props: {
    				player: /*quiz*/ ctx[0].players.SPT,
    				showAnswer: /*answerForm*/ ctx[1].support.correct
    			}
    		});

    	input = new Input({
    			props: {
    				question: /*currentQ*/ ctx[2],
    				onChange: /*handleInputChance*/ ctx[4],
    				onEnter: /*handleInputEnter*/ ctx[5],
    				value: /*answerForm*/ ctx[1][/*currentQ*/ ctx[2]].value
    			}
    		});

    	return {
    		c() {
    			div0 = element("div");
    			create_component(player0.$$.fragment);
    			t0 = space();
    			create_component(player1.$$.fragment);
    			t1 = space();
    			create_component(player2.$$.fragment);
    			t2 = space();
    			create_component(player3.$$.fragment);
    			t3 = space();
    			create_component(player4.$$.fragment);
    			t4 = space();
    			div4 = element("div");
    			div1 = element("div");
    			h40 = element("h4");
    			h40.textContent = "Team";
    			t6 = space();
    			h50 = element("h5");
    			t7 = text(t7_value);
    			t8 = space();
    			div2 = element("div");
    			h41 = element("h4");
    			h41.textContent = "Year";
    			t10 = space();
    			h51 = element("h5");
    			t11 = text(t11_value);
    			t12 = space();
    			div3 = element("div");
    			h42 = element("h4");
    			h42.textContent = "Split";
    			t14 = space();
    			h52 = element("h5");
    			t15 = text(t15_value);
    			t16 = space();
    			div5 = element("div");
    			create_component(input.$$.fragment);
    			attr(div0, "class", "player-container svelte-spsr4q");
    			attr(h40, "class", "team-q-title");
    			attr(h50, "class", "team-q-answer");
    			attr(div1, "class", "team-q-wrapper svelte-spsr4q");
    			attr(h41, "class", "team-q-title");
    			attr(h51, "class", "team-q-answer");
    			attr(div2, "class", "team-q-wrapper svelte-spsr4q");
    			attr(h42, "class", "team-q-title");
    			attr(h52, "class", "team-q-answer");
    			attr(div3, "class", "team-q-wrapper svelte-spsr4q");
    			attr(div4, "class", "team-answer-container svelte-spsr4q");
    			attr(div5, "class", "input-container svelte-spsr4q");
    		},
    		m(target, anchor) {
    			insert(target, div0, anchor);
    			mount_component(player0, div0, null);
    			append(div0, t0);
    			mount_component(player1, div0, null);
    			append(div0, t1);
    			mount_component(player2, div0, null);
    			append(div0, t2);
    			mount_component(player3, div0, null);
    			append(div0, t3);
    			mount_component(player4, div0, null);
    			insert(target, t4, anchor);
    			insert(target, div4, anchor);
    			append(div4, div1);
    			append(div1, h40);
    			append(div1, t6);
    			append(div1, h50);
    			append(h50, t7);
    			append(div4, t8);
    			append(div4, div2);
    			append(div2, h41);
    			append(div2, t10);
    			append(div2, h51);
    			append(h51, t11);
    			append(div4, t12);
    			append(div4, div3);
    			append(div3, h42);
    			append(div3, t14);
    			append(div3, h52);
    			append(h52, t15);
    			insert(target, t16, anchor);
    			insert(target, div5, anchor);
    			mount_component(input, div5, null);
    			current = true;
    		},
    		p(ctx, dirty) {
    			const player0_changes = {};
    			if (dirty & /*quiz*/ 1) player0_changes.player = /*quiz*/ ctx[0].players.TOP;
    			if (dirty & /*answerForm*/ 2) player0_changes.showAnswer = /*answerForm*/ ctx[1].top.correct;
    			player0.$set(player0_changes);
    			const player1_changes = {};
    			if (dirty & /*quiz*/ 1) player1_changes.player = /*quiz*/ ctx[0].players.JG;
    			if (dirty & /*answerForm*/ 2) player1_changes.showAnswer = /*answerForm*/ ctx[1].jungle.correct;
    			player1.$set(player1_changes);
    			const player2_changes = {};
    			if (dirty & /*quiz*/ 1) player2_changes.player = /*quiz*/ ctx[0].players.MID;
    			if (dirty & /*answerForm*/ 2) player2_changes.showAnswer = /*answerForm*/ ctx[1].mid.correct;
    			player2.$set(player2_changes);
    			const player3_changes = {};
    			if (dirty & /*quiz*/ 1) player3_changes.player = /*quiz*/ ctx[0].players.BOT;
    			if (dirty & /*answerForm*/ 2) player3_changes.showAnswer = /*answerForm*/ ctx[1].bot.correct;
    			player3.$set(player3_changes);
    			const player4_changes = {};
    			if (dirty & /*quiz*/ 1) player4_changes.player = /*quiz*/ ctx[0].players.SPT;
    			if (dirty & /*answerForm*/ 2) player4_changes.showAnswer = /*answerForm*/ ctx[1].support.correct;
    			player4.$set(player4_changes);

    			if ((!current || dirty & /*answerForm, quiz*/ 3) && t7_value !== (t7_value = (/*answerForm*/ ctx[1].team.correct
    			? /*quiz*/ ctx[0].team.abbr
    			: "-") + "")) set_data(t7, t7_value);

    			if ((!current || dirty & /*answerForm, quiz*/ 3) && t11_value !== (t11_value = (/*answerForm*/ ctx[1].year.correct
    			? /*quiz*/ ctx[0].year
    			: "-") + "")) set_data(t11, t11_value);

    			if ((!current || dirty & /*answerForm, quiz*/ 3) && t15_value !== (t15_value = (/*answerForm*/ ctx[1].split.correct
    			? /*quiz*/ ctx[0].split
    			: "-") + "")) set_data(t15, t15_value);

    			const input_changes = {};
    			if (dirty & /*currentQ*/ 4) input_changes.question = /*currentQ*/ ctx[2];
    			if (dirty & /*answerForm, currentQ*/ 6) input_changes.value = /*answerForm*/ ctx[1][/*currentQ*/ ctx[2]].value;
    			input.$set(input_changes);
    		},
    		i(local) {
    			if (current) return;
    			transition_in(player0.$$.fragment, local);
    			transition_in(player1.$$.fragment, local);
    			transition_in(player2.$$.fragment, local);
    			transition_in(player3.$$.fragment, local);
    			transition_in(player4.$$.fragment, local);
    			transition_in(input.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(player0.$$.fragment, local);
    			transition_out(player1.$$.fragment, local);
    			transition_out(player2.$$.fragment, local);
    			transition_out(player3.$$.fragment, local);
    			transition_out(player4.$$.fragment, local);
    			transition_out(input.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div0);
    			destroy_component(player0);
    			destroy_component(player1);
    			destroy_component(player2);
    			destroy_component(player3);
    			destroy_component(player4);
    			if (detaching) detach(t4);
    			if (detaching) detach(div4);
    			if (detaching) detach(t16);
    			if (detaching) detach(div5);
    			destroy_component(input);
    		}
    	};
    }

    function create_fragment$5(ctx) {
    	let div;
    	let t;
    	let skipbutton;
    	let current;
    	let if_block = /*quiz*/ ctx[0] && create_if_block$1(ctx);

    	skipbutton = new SkipButton({
    			props: { onClick: /*createQuiz*/ ctx[3] }
    		});

    	return {
    		c() {
    			div = element("div");
    			if (if_block) if_block.c();
    			t = space();
    			create_component(skipbutton.$$.fragment);
    			attr(div, "class", "quiz-container svelte-spsr4q");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			if (if_block) if_block.m(div, null);
    			append(div, t);
    			mount_component(skipbutton, div, null);
    			current = true;
    		},
    		p(ctx, [dirty]) {
    			if (/*quiz*/ ctx[0]) {
    				if (if_block) {
    					if_block.p(ctx, dirty);

    					if (dirty & /*quiz*/ 1) {
    						transition_in(if_block, 1);
    					}
    				} else {
    					if_block = create_if_block$1(ctx);
    					if_block.c();
    					transition_in(if_block, 1);
    					if_block.m(div, t);
    				}
    			} else if (if_block) {
    				group_outros();

    				transition_out(if_block, 1, 1, () => {
    					if_block = null;
    				});

    				check_outros();
    			}
    		},
    		i(local) {
    			if (current) return;
    			transition_in(if_block);
    			transition_in(skipbutton.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(if_block);
    			transition_out(skipbutton.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div);
    			if (if_block) if_block.d();
    			destroy_component(skipbutton);
    		}
    	};
    }

    function instance$1($$self, $$props, $$invalidate) {
    	let quizNo;
    	let answeredPool = [];
    	let quiz;
    	let answerForm;
    	let currentQ = "team";
    	const fullPool = data.map((_, i) => i);

    	const defaultAnswerForm = {
    		team: { value: "", answer: [], correct: false },
    		year: { value: "", answer: [], correct: false },
    		split: { value: "", answer: [], correct: false },
    		top: { value: "", answer: [], correct: false },
    		jungle: { value: "", answer: [], correct: false },
    		mid: { value: "", answer: [], correct: false },
    		bot: { value: "", answer: [], correct: false },
    		support: { value: "", answer: [], correct: false }
    	};

    	let qs = [...Object.keys(defaultAnswerForm)];

    	function resetAnswerForm() {
    		$$invalidate(1, answerForm = JSON.parse(JSON.stringify(defaultAnswerForm)));
    	}

    	function createQuiz() {
    		resetAnswerForm();
    		const pool = fullPool.filter(i => !answeredPool.includes(i));
    		quizNo = pool[Math.floor(Math.random() * pool.length)];
    		answeredPool.push(quizNo);
    		$$invalidate(0, quiz = data[quizNo]);
    		$$invalidate(1, answerForm.team.answer = [...quiz.team.name.map(n => n.toLowerCase()), quiz.team.abbr.toLowerCase()], answerForm);
    		$$invalidate(1, answerForm.year.answer = quiz.year, answerForm);
    		$$invalidate(1, answerForm.split.answer = quiz.split.toLowerCase(), answerForm);
    		$$invalidate(1, answerForm.top.answer = quiz.players.TOP.ign.toLowerCase(), answerForm);
    		$$invalidate(1, answerForm.jungle.answer = quiz.players.JG.ign.toLowerCase(), answerForm);
    		$$invalidate(1, answerForm.mid.answer = quiz.players.MID.ign.toLowerCase(), answerForm);
    		$$invalidate(1, answerForm.bot.answer = quiz.players.BOT.ign.toLowerCase(), answerForm);
    		$$invalidate(1, answerForm.support.answer = quiz.players.SPT.ign.toLowerCase(), answerForm);
    	}

    	function handleInputChance(key, value) {
    		$$invalidate(1, answerForm[key].value = value, answerForm);
    	}

    	function handleInputEnter(key) {
    		if (key === "team" && answerForm.team.answer.includes(answerForm[key].value.toLowerCase()) || key !== "team" && answerForm[key].answer === answerForm[key].value.toLowerCase()) {
    			$$invalidate(1, answerForm[key].correct = true, answerForm);
    			qs.shift();

    			if (qs.length === 0) {
    				qs = [...Object.keys(defaultAnswerForm)];
    				createQuiz();
    			}

    			$$invalidate(2, currentQ = qs[0]);
    		}
    	}

    	onMount(() => {
    		createQuiz();
    	});

    	return [quiz, answerForm, currentQ, createQuiz, handleInputChance, handleInputEnter];
    }

    class Quiz extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-spsr4q-style")) add_css$4();
    		init(this, options, instance$1, create_fragment$5, safe_not_equal, {});
    	}
    }

    /* src/components/Rules.svelte generated by Svelte v3.38.3 */

    function add_css$3() {
    	var style = element("style");
    	style.id = "svelte-tcv1g3-style";
    	style.textContent = ".rules-container.svelte-tcv1g3.svelte-tcv1g3{display:flex;flex-direction:column;align-items:center}.rules-ul.svelte-tcv1g3.svelte-tcv1g3{margin:0;list-style:none}.rules-ul.svelte-tcv1g3>li.svelte-tcv1g3::before{content:'・'}";
    	append(document.head, style);
    }

    function create_fragment$4(ctx) {
    	let div;

    	return {
    		c() {
    			div = element("div");

    			div.innerHTML = `<h3 class="rules-title">Rules</h3> 
  <ul class="rules-ul svelte-tcv1g3"><li class="svelte-tcv1g3">Including NALCS, LCS, EULCS, LEC teams. Academy rosters are not included.</li> 
    <li class="svelte-tcv1g3">From 2013 spring to 2021 summer.</li> 
    <li class="svelte-tcv1g3">If a roster exists for over a split, the answer is the first split in that period.</li> 
    <li class="svelte-tcv1g3">Data is based on <a href="https://lol.fandom.com/wiki/League_of_Legends_Esports_Wiki" rel="noreferrer noopener" target="_blank">Leaguepedia</a>.</li></ul>`;

    			attr(div, "class", "rules-container svelte-tcv1g3");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    		},
    		p: noop,
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(div);
    		}
    	};
    }

    class Rules extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-tcv1g3-style")) add_css$3();
    		init(this, options, null, create_fragment$4, safe_not_equal, {});
    	}
    }

    /* node_modules/svelte-fa/src/fa.svelte generated by Svelte v3.38.3 */

    function create_if_block(ctx) {
    	let svg;
    	let g1;
    	let g0;
    	let svg_viewBox_value;

    	function select_block_type(ctx, dirty) {
    		if (typeof /*i*/ ctx[8][4] == "string") return create_if_block_1;
    		return create_else_block;
    	}

    	let current_block_type = select_block_type(ctx);
    	let if_block = current_block_type(ctx);

    	return {
    		c() {
    			svg = svg_element("svg");
    			g1 = svg_element("g");
    			g0 = svg_element("g");
    			if_block.c();
    			attr(g0, "transform", /*transform*/ ctx[10]);
    			attr(g1, "transform", "translate(256 256)");
    			attr(svg, "id", /*id*/ ctx[1]);
    			attr(svg, "class", /*clazz*/ ctx[0]);
    			attr(svg, "style", /*s*/ ctx[9]);
    			attr(svg, "viewBox", svg_viewBox_value = `0 0 ${/*i*/ ctx[8][0]} ${/*i*/ ctx[8][1]}`);
    			attr(svg, "aria-hidden", "true");
    			attr(svg, "role", "img");
    			attr(svg, "xmlns", "http://www.w3.org/2000/svg");
    		},
    		m(target, anchor) {
    			insert(target, svg, anchor);
    			append(svg, g1);
    			append(g1, g0);
    			if_block.m(g0, null);
    		},
    		p(ctx, dirty) {
    			if (current_block_type === (current_block_type = select_block_type(ctx)) && if_block) {
    				if_block.p(ctx, dirty);
    			} else {
    				if_block.d(1);
    				if_block = current_block_type(ctx);

    				if (if_block) {
    					if_block.c();
    					if_block.m(g0, null);
    				}
    			}

    			if (dirty & /*transform*/ 1024) {
    				attr(g0, "transform", /*transform*/ ctx[10]);
    			}

    			if (dirty & /*id*/ 2) {
    				attr(svg, "id", /*id*/ ctx[1]);
    			}

    			if (dirty & /*clazz*/ 1) {
    				attr(svg, "class", /*clazz*/ ctx[0]);
    			}

    			if (dirty & /*s*/ 512) {
    				attr(svg, "style", /*s*/ ctx[9]);
    			}

    			if (dirty & /*i*/ 256 && svg_viewBox_value !== (svg_viewBox_value = `0 0 ${/*i*/ ctx[8][0]} ${/*i*/ ctx[8][1]}`)) {
    				attr(svg, "viewBox", svg_viewBox_value);
    			}
    		},
    		d(detaching) {
    			if (detaching) detach(svg);
    			if_block.d();
    		}
    	};
    }

    // (124:8) {:else}
    function create_else_block(ctx) {
    	let path0;
    	let path0_d_value;
    	let path0_fill_value;
    	let path0_fill_opacity_value;
    	let path1;
    	let path1_d_value;
    	let path1_fill_value;
    	let path1_fill_opacity_value;

    	return {
    		c() {
    			path0 = svg_element("path");
    			path1 = svg_element("path");
    			attr(path0, "d", path0_d_value = /*i*/ ctx[8][4][0]);
    			attr(path0, "fill", path0_fill_value = /*secondaryColor*/ ctx[4] || /*color*/ ctx[2] || "currentColor");

    			attr(path0, "fill-opacity", path0_fill_opacity_value = /*swapOpacity*/ ctx[7] != false
    			? /*primaryOpacity*/ ctx[5]
    			: /*secondaryOpacity*/ ctx[6]);

    			attr(path0, "transform", "translate(-256 -256)");
    			attr(path1, "d", path1_d_value = /*i*/ ctx[8][4][1]);
    			attr(path1, "fill", path1_fill_value = /*primaryColor*/ ctx[3] || /*color*/ ctx[2] || "currentColor");

    			attr(path1, "fill-opacity", path1_fill_opacity_value = /*swapOpacity*/ ctx[7] != false
    			? /*secondaryOpacity*/ ctx[6]
    			: /*primaryOpacity*/ ctx[5]);

    			attr(path1, "transform", "translate(-256 -256)");
    		},
    		m(target, anchor) {
    			insert(target, path0, anchor);
    			insert(target, path1, anchor);
    		},
    		p(ctx, dirty) {
    			if (dirty & /*i*/ 256 && path0_d_value !== (path0_d_value = /*i*/ ctx[8][4][0])) {
    				attr(path0, "d", path0_d_value);
    			}

    			if (dirty & /*secondaryColor, color*/ 20 && path0_fill_value !== (path0_fill_value = /*secondaryColor*/ ctx[4] || /*color*/ ctx[2] || "currentColor")) {
    				attr(path0, "fill", path0_fill_value);
    			}

    			if (dirty & /*swapOpacity, primaryOpacity, secondaryOpacity*/ 224 && path0_fill_opacity_value !== (path0_fill_opacity_value = /*swapOpacity*/ ctx[7] != false
    			? /*primaryOpacity*/ ctx[5]
    			: /*secondaryOpacity*/ ctx[6])) {
    				attr(path0, "fill-opacity", path0_fill_opacity_value);
    			}

    			if (dirty & /*i*/ 256 && path1_d_value !== (path1_d_value = /*i*/ ctx[8][4][1])) {
    				attr(path1, "d", path1_d_value);
    			}

    			if (dirty & /*primaryColor, color*/ 12 && path1_fill_value !== (path1_fill_value = /*primaryColor*/ ctx[3] || /*color*/ ctx[2] || "currentColor")) {
    				attr(path1, "fill", path1_fill_value);
    			}

    			if (dirty & /*swapOpacity, secondaryOpacity, primaryOpacity*/ 224 && path1_fill_opacity_value !== (path1_fill_opacity_value = /*swapOpacity*/ ctx[7] != false
    			? /*secondaryOpacity*/ ctx[6]
    			: /*primaryOpacity*/ ctx[5])) {
    				attr(path1, "fill-opacity", path1_fill_opacity_value);
    			}
    		},
    		d(detaching) {
    			if (detaching) detach(path0);
    			if (detaching) detach(path1);
    		}
    	};
    }

    // (118:8) {#if typeof i[4] == 'string'}
    function create_if_block_1(ctx) {
    	let path;
    	let path_d_value;
    	let path_fill_value;

    	return {
    		c() {
    			path = svg_element("path");
    			attr(path, "d", path_d_value = /*i*/ ctx[8][4]);
    			attr(path, "fill", path_fill_value = /*color*/ ctx[2] || /*primaryColor*/ ctx[3] || "currentColor");
    			attr(path, "transform", "translate(-256 -256)");
    		},
    		m(target, anchor) {
    			insert(target, path, anchor);
    		},
    		p(ctx, dirty) {
    			if (dirty & /*i*/ 256 && path_d_value !== (path_d_value = /*i*/ ctx[8][4])) {
    				attr(path, "d", path_d_value);
    			}

    			if (dirty & /*color, primaryColor*/ 12 && path_fill_value !== (path_fill_value = /*color*/ ctx[2] || /*primaryColor*/ ctx[3] || "currentColor")) {
    				attr(path, "fill", path_fill_value);
    			}
    		},
    		d(detaching) {
    			if (detaching) detach(path);
    		}
    	};
    }

    function create_fragment$3(ctx) {
    	let if_block_anchor;
    	let if_block = /*i*/ ctx[8][4] && create_if_block(ctx);

    	return {
    		c() {
    			if (if_block) if_block.c();
    			if_block_anchor = empty();
    		},
    		m(target, anchor) {
    			if (if_block) if_block.m(target, anchor);
    			insert(target, if_block_anchor, anchor);
    		},
    		p(ctx, [dirty]) {
    			if (/*i*/ ctx[8][4]) {
    				if (if_block) {
    					if_block.p(ctx, dirty);
    				} else {
    					if_block = create_if_block(ctx);
    					if_block.c();
    					if_block.m(if_block_anchor.parentNode, if_block_anchor);
    				}
    			} else if (if_block) {
    				if_block.d(1);
    				if_block = null;
    			}
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (if_block) if_block.d(detaching);
    			if (detaching) detach(if_block_anchor);
    		}
    	};
    }

    function instance($$self, $$props, $$invalidate) {
    	let { class: clazz = "" } = $$props;
    	let { id = "" } = $$props;
    	let { style = "" } = $$props;
    	let { icon } = $$props;
    	let { fw = false } = $$props;
    	let { flip = false } = $$props;
    	let { pull = "" } = $$props;
    	let { rotate = "" } = $$props;
    	let { size = "" } = $$props;
    	let { color = "" } = $$props;
    	let { primaryColor = "" } = $$props;
    	let { secondaryColor = "" } = $$props;
    	let { primaryOpacity = 1 } = $$props;
    	let { secondaryOpacity = 0.4 } = $$props;
    	let { swapOpacity = false } = $$props;
    	let i;
    	let s;
    	let transform;

    	$$self.$$set = $$props => {
    		if ("class" in $$props) $$invalidate(0, clazz = $$props.class);
    		if ("id" in $$props) $$invalidate(1, id = $$props.id);
    		if ("style" in $$props) $$invalidate(11, style = $$props.style);
    		if ("icon" in $$props) $$invalidate(12, icon = $$props.icon);
    		if ("fw" in $$props) $$invalidate(13, fw = $$props.fw);
    		if ("flip" in $$props) $$invalidate(14, flip = $$props.flip);
    		if ("pull" in $$props) $$invalidate(15, pull = $$props.pull);
    		if ("rotate" in $$props) $$invalidate(16, rotate = $$props.rotate);
    		if ("size" in $$props) $$invalidate(17, size = $$props.size);
    		if ("color" in $$props) $$invalidate(2, color = $$props.color);
    		if ("primaryColor" in $$props) $$invalidate(3, primaryColor = $$props.primaryColor);
    		if ("secondaryColor" in $$props) $$invalidate(4, secondaryColor = $$props.secondaryColor);
    		if ("primaryOpacity" in $$props) $$invalidate(5, primaryOpacity = $$props.primaryOpacity);
    		if ("secondaryOpacity" in $$props) $$invalidate(6, secondaryOpacity = $$props.secondaryOpacity);
    		if ("swapOpacity" in $$props) $$invalidate(7, swapOpacity = $$props.swapOpacity);
    	};

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty & /*icon*/ 4096) {
    			$$invalidate(8, i = icon && icon.icon || [0, 0, "", [], ""]);
    		}

    		if ($$self.$$.dirty & /*fw, pull, size, style*/ 174080) {
    			{
    				let float;
    				let width;
    				const height = "1em";
    				let lineHeight;
    				let fontSize;
    				let textAlign;
    				let verticalAlign = "-.125em";
    				const overflow = "visible";

    				if (fw) {
    					textAlign = "center";
    					width = "1.25em";
    				}

    				if (pull) {
    					float = pull;
    				}

    				if (size) {
    					if (size == "lg") {
    						fontSize = "1.33333em";
    						lineHeight = ".75em";
    						verticalAlign = "-.225em";
    					} else if (size == "xs") {
    						fontSize = ".75em";
    					} else if (size == "sm") {
    						fontSize = ".875em";
    					} else {
    						fontSize = size.replace("x", "em");
    					}
    				}

    				const styleObj = {
    					float,
    					width,
    					height,
    					"line-height": lineHeight,
    					"font-size": fontSize,
    					"text-align": textAlign,
    					"vertical-align": verticalAlign,
    					overflow
    				};

    				let styleStr = "";

    				for (const prop in styleObj) {
    					if (styleObj[prop]) {
    						styleStr += `${prop}:${styleObj[prop]};`;
    					}
    				}

    				$$invalidate(9, s = styleStr + style);
    			}
    		}

    		if ($$self.$$.dirty & /*flip, rotate*/ 81920) {
    			{
    				let t = "";

    				if (flip) {
    					let flipX = 1;
    					let flipY = 1;

    					if (flip == "horizontal") {
    						flipX = -1;
    					} else if (flip == "vertical") {
    						flipY = -1;
    					} else {
    						flipX = flipY = -1;
    					}

    					t += ` scale(${flipX} ${flipY})`;
    				}

    				if (rotate) {
    					t += ` rotate(${rotate} 0 0)`;
    				}

    				$$invalidate(10, transform = t);
    			}
    		}
    	};

    	return [
    		clazz,
    		id,
    		color,
    		primaryColor,
    		secondaryColor,
    		primaryOpacity,
    		secondaryOpacity,
    		swapOpacity,
    		i,
    		s,
    		transform,
    		style,
    		icon,
    		fw,
    		flip,
    		pull,
    		rotate,
    		size
    	];
    }

    class Fa extends SvelteComponent {
    	constructor(options) {
    		super();

    		init(this, options, instance, create_fragment$3, safe_not_equal, {
    			class: 0,
    			id: 1,
    			style: 11,
    			icon: 12,
    			fw: 13,
    			flip: 14,
    			pull: 15,
    			rotate: 16,
    			size: 17,
    			color: 2,
    			primaryColor: 3,
    			secondaryColor: 4,
    			primaryOpacity: 5,
    			secondaryOpacity: 6,
    			swapOpacity: 7
    		});
    	}
    }

    /*!
     * Font Awesome Free 5.15.3 by @fontawesome - https://fontawesome.com
     * License - https://fontawesome.com/license/free (Icons: CC BY 4.0, Fonts: SIL OFL 1.1, Code: MIT License)
     */
    var faGithub = {
      prefix: 'fab',
      iconName: 'github',
      icon: [496, 512, [], "f09b", "M165.9 397.4c0 2-2.3 3.6-5.2 3.6-3.3.3-5.6-1.3-5.6-3.6 0-2 2.3-3.6 5.2-3.6 3-.3 5.6 1.3 5.6 3.6zm-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9 2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3zm44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9.3 2 2.9 3.3 5.9 2.6 2.9-.7 4.9-2.6 4.6-4.6-.3-1.9-3-3.2-5.9-2.9zM244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2 12.8 2.3 17.3-5.6 17.3-12.1 0-6.2-.3-40.4-.3-61.4 0 0-70 15-84.7-29.8 0 0-11.4-29.1-27.8-36.6 0 0-22.9-15.7 1.6-15.4 0 0 24.9 2 38.6 25.8 21.9 38.6 58.6 27.5 72.9 20.9 2.3-16 8.8-27.1 16-33.7-55.9-6.2-112.3-14.3-112.3-110.5 0-27.5 7.6-41.3 23.6-58.9-2.6-6.5-11.1-33.3 2.6-67.9 20.9-6.5 69 27 69 27 20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27 13.7 34.7 5.2 61.4 2.6 67.9 16 17.7 25.8 31.5 25.8 58.9 0 96.5-58.9 104.2-114.8 110.5 9.2 7.9 17 22.9 17 46.4 0 33.7-.3 75.4-.3 83.6 0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252 496 113.3 383.5 8 244.8 8zM97.2 352.9c-1.3 1-1 3.3.7 5.2 1.6 1.6 3.9 2.3 5.2 1 1.3-1 1-3.3-.7-5.2-1.6-1.6-3.9-2.3-5.2-1zm-10.8-8.1c-.7 1.3.3 2.9 2.3 3.9 1.6 1 3.6.7 4.3-.7.7-1.3-.3-2.9-2.3-3.9-2-.6-3.6-.3-4.3.7zm32.4 35.6c-1.6 1.3-1 4.3 1.3 6.2 2.3 2.3 5.2 2.6 6.5 1 1.3-1.3.7-4.3-1.3-6.2-2.2-2.3-5.2-2.6-6.5-1zm-11.4-14.7c-1.6 1-1.6 3.6 0 5.9 1.6 2.3 4.3 3.3 5.6 2.3 1.6-1.3 1.6-3.9 0-6.2-1.4-2.3-4-3.3-5.6-2z"]
    };
    var faTwitter = {
      prefix: 'fab',
      iconName: 'twitter',
      icon: [512, 512, [], "f099", "M459.37 151.716c.325 4.548.325 9.097.325 13.645 0 138.72-105.583 298.558-298.558 298.558-59.452 0-114.68-17.219-161.137-47.106 8.447.974 16.568 1.299 25.34 1.299 49.055 0 94.213-16.568 130.274-44.832-46.132-.975-84.792-31.188-98.112-72.772 6.498.974 12.995 1.624 19.818 1.624 9.421 0 18.843-1.3 27.614-3.573-48.081-9.747-84.143-51.98-84.143-102.985v-1.299c13.969 7.797 30.214 12.67 47.431 13.319-28.264-18.843-46.781-51.005-46.781-87.391 0-19.492 5.197-37.36 14.294-52.954 51.655 63.675 129.3 105.258 216.365 109.807-1.624-7.797-2.599-15.918-2.599-24.04 0-57.828 46.782-104.934 104.934-104.934 30.213 0 57.502 12.67 76.67 33.137 23.715-4.548 46.456-13.32 66.599-25.34-7.798 24.366-24.366 44.833-46.132 57.827 21.117-2.273 41.584-8.122 60.426-16.243-14.292 20.791-32.161 39.308-52.628 54.253z"]
    };

    /* src/components/Footer.svelte generated by Svelte v3.38.3 */

    function add_css$2() {
    	var style = element("style");
    	style.id = "svelte-14r4rj2-style";
    	style.textContent = ".footer-wrapper.svelte-14r4rj2{width:100%;display:flex;justify-content:flex-end}a.svelte-14r4rj2{margin:0 10px;font-size:20px}";
    	append(document.head, style);
    }

    function create_fragment$2(ctx) {
    	let div;
    	let a0;
    	let fa0;
    	let t;
    	let a1;
    	let fa1;
    	let current;
    	fa0 = new Fa({ props: { icon: faTwitter } });
    	fa1 = new Fa({ props: { icon: faGithub } });

    	return {
    		c() {
    			div = element("div");
    			a0 = element("a");
    			create_component(fa0.$$.fragment);
    			t = space();
    			a1 = element("a");
    			create_component(fa1.$$.fragment);
    			attr(a0, "href", "https://twitter.com/asukachikaru");
    			attr(a0, "rel", "noreferrer noopener");
    			attr(a0, "target", "_blank");
    			attr(a0, "class", "svelte-14r4rj2");
    			attr(a1, "href", "https://github.com/AsukaCHikaru/lcs-lec-flag-quiz");
    			attr(a1, "rel", "noreferrer noopener");
    			attr(a1, "target", "_blank");
    			attr(a1, "class", "svelte-14r4rj2");
    			attr(div, "class", "footer-wrapper svelte-14r4rj2");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			append(div, a0);
    			mount_component(fa0, a0, null);
    			append(div, t);
    			append(div, a1);
    			mount_component(fa1, a1, null);
    			current = true;
    		},
    		p: noop,
    		i(local) {
    			if (current) return;
    			transition_in(fa0.$$.fragment, local);
    			transition_in(fa1.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(fa0.$$.fragment, local);
    			transition_out(fa1.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div);
    			destroy_component(fa0);
    			destroy_component(fa1);
    		}
    	};
    }

    class Footer extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-14r4rj2-style")) add_css$2();
    		init(this, options, null, create_fragment$2, safe_not_equal, {});
    	}
    }

    /* src/components/Layout.svelte generated by Svelte v3.38.3 */

    function add_css$1() {
    	var style = element("style");
    	style.id = "svelte-s3q65m-style";
    	style.textContent = ".layout-container.svelte-s3q65m{height:calc(100% - 4em);max-width:800px;margin:auto;padding:2em 0;display:flex;flex-direction:column}.content-container.svelte-s3q65m{flex-grow:1;display:flex;flex-direction:column;justify-content:center}";
    	append(document.head, style);
    }

    function create_fragment$1(ctx) {
    	let div1;
    	let div0;
    	let title;
    	let t0;
    	let quiz;
    	let t1;
    	let rules;
    	let t2;
    	let footer;
    	let current;
    	title = new Title({});
    	quiz = new Quiz({});
    	rules = new Rules({});
    	footer = new Footer({});

    	return {
    		c() {
    			div1 = element("div");
    			div0 = element("div");
    			create_component(title.$$.fragment);
    			t0 = space();
    			create_component(quiz.$$.fragment);
    			t1 = space();
    			create_component(rules.$$.fragment);
    			t2 = space();
    			create_component(footer.$$.fragment);
    			attr(div0, "class", "content-container svelte-s3q65m");
    			attr(div1, "class", "layout-container svelte-s3q65m");
    		},
    		m(target, anchor) {
    			insert(target, div1, anchor);
    			append(div1, div0);
    			mount_component(title, div0, null);
    			append(div0, t0);
    			mount_component(quiz, div0, null);
    			append(div0, t1);
    			mount_component(rules, div0, null);
    			append(div1, t2);
    			mount_component(footer, div1, null);
    			current = true;
    		},
    		p: noop,
    		i(local) {
    			if (current) return;
    			transition_in(title.$$.fragment, local);
    			transition_in(quiz.$$.fragment, local);
    			transition_in(rules.$$.fragment, local);
    			transition_in(footer.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(title.$$.fragment, local);
    			transition_out(quiz.$$.fragment, local);
    			transition_out(rules.$$.fragment, local);
    			transition_out(footer.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div1);
    			destroy_component(title);
    			destroy_component(quiz);
    			destroy_component(rules);
    			destroy_component(footer);
    		}
    	};
    }

    class Layout extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-s3q65m-style")) add_css$1();
    		init(this, options, null, create_fragment$1, safe_not_equal, {});
    	}
    }

    /* src/App.svelte generated by Svelte v3.38.3 */

    function add_css() {
    	var style = element("style");
    	style.id = "svelte-17pnb6i-style";
    	style.textContent = ".app.svelte-17pnb6i{height:100vh;width:100%}";
    	append(document.head, style);
    }

    function create_fragment(ctx) {
    	let div;
    	let layout;
    	let current;
    	layout = new Layout({});

    	return {
    		c() {
    			div = element("div");
    			create_component(layout.$$.fragment);
    			attr(div, "class", "app svelte-17pnb6i");
    		},
    		m(target, anchor) {
    			insert(target, div, anchor);
    			mount_component(layout, div, null);
    			current = true;
    		},
    		p: noop,
    		i(local) {
    			if (current) return;
    			transition_in(layout.$$.fragment, local);
    			current = true;
    		},
    		o(local) {
    			transition_out(layout.$$.fragment, local);
    			current = false;
    		},
    		d(detaching) {
    			if (detaching) detach(div);
    			destroy_component(layout);
    		}
    	};
    }

    class App extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-17pnb6i-style")) add_css();
    		init(this, options, null, create_fragment, safe_not_equal, {});
    	}
    }

    const app = new App({
      target: document.body,
      props: {
        name: 'asuka'
      }
    });

    return app;

}());