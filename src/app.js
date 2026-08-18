'use client';

/* =============================================================================
   Sydney to New York — an editable, nestable checklist.

   Architecture
   ------------
   Layer 0  storage    Safe persistence adapter. Probes localStorage, silently
                       degrades to an in-memory map. Never throws.
   Layer 1  model      Pure functions over a normalised document. No React,
                       no store, no DOM. Every structural rule lives here.
   Layer 2  store      Zustand vanilla store + persist middleware. Wraps every
                       mutation in `commit`, which owns cloning, undo history
                       and focus intent.
   Layer 3  bindings   useStore via React 18's useSyncExternalStore. Selectors
                       return primitives or stable references so a keystroke in
                       one row never re-renders the other hundred.
   Layer 4  view       Components. Editable is deliberately uncontrolled: React
                       never writes into a focused contenteditable, which is the
                       only reliable way to keep a caret alive.

   Document shape (the persisted unit)
   -----------------------------------
     { v, meta, order:[sectionId], sections:{id:{title,lede}},
       items:{id:{text,note,done,parent}}, children:{containerId:[itemId]} }

   `children` is the single source of truth for ordering; `parent` is a
   denormalised back-pointer. Both are only ever written by the two primitives
   `detach` and `insertAt`, so they cannot drift.

   Depth is derived, never stored: an item whose parent is a section is depth 0,
   an item whose parent is an item is depth 1. `insertAt` refuses to create a
   depth 2, so the one-level rule is an invariant of the model rather than a
   convention the UI has to remember.

   `done` on a parent is derived, not stored. A parent with children reports
   none / some / all from its children, which removes the entire class of
   "parent says done, child says not" bugs.
============================================================================= */

import React, {
  useSyncExternalStore, useRef, useEffect, useLayoutEffect,
  useState, useCallback, useMemo, memo, Fragment
} from 'react';
import { createStore } from 'zustand/vanilla';
import { persist, createJSONStorage } from 'zustand/middleware';
import htm from 'htm';
const html = htm.bind(React.createElement);

const KEY = 'sydney-nyc-checklist';
const VERSION = 1;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

/* =============================================================================
   Layer 0 — storage
============================================================================= */

function createSafeStorage() {
  const mem = new Map();
  let live = false;
  try {
    const probe = '__probe__' + Math.random();
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    live = true;
  } catch (e) {
    live = false; // private mode, sandboxed iframe, disabled storage
  }

  // Coalesce bursts of writes (one per keystroke) into one write per frame-ish.
  let pending = null, timer = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const [k, v] = pending; pending = null;
    try { window.localStorage.setItem(k, v); } catch (e) { live = false; mem.set(k, v); }
  };

  return {
    get live() { return live; },
    getItem(name) {
      try { return live ? window.localStorage.getItem(name) : (mem.has(name) ? mem.get(name) : null); }
      catch (e) { return mem.has(name) ? mem.get(name) : null; }
    },
    setItem(name, value) {
      mem.set(name, value);
      if (!live) return;
      pending = [name, value];
      if (!timer) timer = setTimeout(flush, 200);
    },
    removeItem(name) {
      mem.delete(name);
      try { if (live) window.localStorage.removeItem(name); } catch (e) {}
    }
  };
}

const safeStorage = createSafeStorage();

/* =============================================================================
   Layer 1 — model (pure)
============================================================================= */

const isSection = (doc, id) => Object.prototype.hasOwnProperty.call(doc.sections, id);
const kidsOf = (doc, id) => doc.children[id] || [];
const depthOf = (doc, id) => {
  const it = doc.items[id];
  return it && isSection(doc, it.parent) ? 0 : 1;
};

/** Remove an id from its current container. Leaves the entity intact. */
function detach(doc, id) {
  const it = doc.items[id];
  if (!it) return -1;
  const arr = doc.children[it.parent];
  if (!arr) return -1;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  return i;
}

/**
 * Insert an item into a container at an index.
 * Enforces the one-level rule: a container that is itself a child cannot
 * take children, and an item that has children cannot become a child.
 */
function insertAt(doc, containerId, id, index) {
  const containerIsItem = !isSection(doc, containerId);
  if (containerIsItem) {
    if (depthOf(doc, containerId) !== 0) return false;   // would be depth 2
    if (kidsOf(doc, id).length) return false;            // would drag kids to depth 2
  }
  if (!doc.children[containerId]) doc.children[containerId] = [];
  const arr = doc.children[containerId];
  const at = (index == null || index < 0 || index > arr.length) ? arr.length : index;
  arr.splice(at, 0, id);
  doc.items[id].parent = containerId;
  return true;
}

function newItem(doc, text = '', note = '') {
  const id = uid();
  doc.items[id] = { id, text, note, done: false, parent: null };
  return id;
}

/** Delete an item and everything under it. */
function removeDeep(doc, id) {
  kidsOf(doc, id).slice().forEach((k) => removeDeep(doc, k));
  delete doc.children[id];
  detach(doc, id);
  delete doc.items[id];
}

/** Visual order, flattened. The basis for all caret navigation. */
function flatten(doc) {
  const out = [];
  doc.order.forEach((sid) => {
    kidsOf(doc, sid).forEach((id) => {
      out.push({ id, depth: 0, section: sid });
      kidsOf(doc, id).forEach((cid) => out.push({ id: cid, depth: 1, section: sid }));
    });
  });
  return out;
}

/** none | some | all — derived for parents, stored for leaves. */
function stateOf(doc, id) {
  const kids = kidsOf(doc, id);
  if (!kids.length) return doc.items[id].done ? 'all' : 'none';
  let done = 0;
  kids.forEach((k) => { if (doc.items[k].done) done++; });
  return done === 0 ? 'none' : done === kids.length ? 'all' : 'some';
}

/** Only leaves count. A parent is a heading, not a task. */
function tally(doc) {
  let total = 0, done = 0;
  Object.keys(doc.items).forEach((id) => {
    if (kidsOf(doc, id).length) return;
    total++;
    if (doc.items[id].done) done++;
  });
  return { total, done };
}

/**
 * Derived values keyed on document identity.
 * useSyncExternalStore compares snapshots by reference, so any selector that
 * builds an object must return the *same* object until the doc actually
 * changes. Without this, every render produces a new tally and React loops.
 */
function byDoc(fn) {
  const cache = new WeakMap();
  return (doc) => {
    if (!cache.has(doc)) cache.set(doc, fn(doc));
    return cache.get(doc);
  };
}
const tallyOf = byDoc(tally);
const flatOf = byDoc(flatten);

function setDoneDeep(doc, id, value) {
  doc.items[id].done = value;
  kidsOf(doc, id).forEach((k) => setDoneDeep(doc, k, value));
}

/** Repair pass. Cheap insurance against a hand-edited or half-migrated import. */
function normalise(doc) {
  doc.order = (doc.order || []).filter((s) => doc.sections[s]);
  const seen = new Set();
  const walk = (containerId, depth) => {
    doc.children[containerId] = kidsOf(doc, containerId).filter((id) => {
      if (!doc.items[id] || seen.has(id) || depth > 1) return false;
      seen.add(id);
      doc.items[id].parent = containerId;
      walk(id, depth + 1);
      return true;
    });
  };
  doc.order.forEach((s) => walk(s, 0));
  Object.keys(doc.items).forEach((id) => { if (!seen.has(id)) delete doc.items[id]; });
  Object.keys(doc.children).forEach((c) => {
    if (!doc.sections[c] && !doc.items[c]) delete doc.children[c];
  });
  return doc;
}

/* =============================================================================
   Seed content
============================================================================= */

const SEED = {
  meta: {
    title: 'Two bags.\nOne week.',
    sub: "Everything you own goes to New York, to your parents' house, or to someone else.",
    when: 'Departing 25 August'
  },
  sections: [
    { title: 'Today', lede: 'Six things. The rest of the week depends on them.', items: [
      ['Ask the sublet what’s already in the flat', 'This decides half your packing.',
        ['Bedding and pillows', 'Towels', 'Kitchenware and pots', 'Wifi, laundry, desk lamp']],
      ['List everything you’re selling', 'It takes three to five days to actually sell. Post tonight.'],
      ['Book a GP appointment', 'Repeat scripts and a medication letter. Far cheaper here than there.'],
      ['Confirm your airline’s baggage allowance'],
      ['Buy boxes, tape and a luggage scale'],
      ['Sort the room into four piles', 'There is no maybe pile.',
        ['New York', 'Parents’ house', 'Sell or give away', 'Bin']]
    ]},
    { title: 'Carry on', lede: 'Assume both checked bags vanish for three days. This is what makes that fine.', items: [
      ['Passport with F-1 visa'],
      ['I-20, signed and dated', 'An unsigned I-20 is the most common problem at the border.'],
      ['SEVIS receipt and NYU admission letter'],
      ['Proof of funds and both loan agreements'],
      ['Immunisation record, printed', 'NYU won’t let you enrol without proof of MMR.'],
      ['Records you can’t get sent from overseas', '',
        ['Birth certificate', 'Degree certificate and transcripts', 'Driver’s licence']],
      ['Medication in original packaging', 'Never in a pill organiser. The label is the proof.',
        ['Doctor’s letter with generic drug names', 'Ninety days maximum, not a year’s supply', 'Spare glasses and your prescription']],
      ['USD $300 cash and two cards from two banks'],
      ['Tech', 'Power banks are banned from checked bags.',
        ['Laptop and charger', 'Phone, charger, power bank', 'Three US plug adapters', 'US eSIM, activated before you board']],
      ['Your NYC address and landlord’s number, printed'],
      ['One change of clothes'],
      ['Everything above, scanned to the cloud']
    ]},
    { title: 'Checked bags', lede: 'Two weeks of clothes, not two years. New York sells things.', items: [
      ['Two weeks of underwear and socks'],
      ['Eight tops, three shirts, three jumpers'],
      ['Jeans, chinos, shorts'],
      ['One good outfit', 'New York invents occasions faster than any other city.',
        ['Blazer', 'Dress shirt and trousers', 'Dress shoes and a belt']],
      ['Three pairs of shoes, no more', 'The heaviest thing you own per unit of use.',
        ['Walking sneakers, already broken in', 'Dress shoes', 'Slides for the shared bathroom']],
      ['Rain jacket and a proper umbrella'],
      ['Gym gear, swimmers, sunglasses'],
      ['Toiletries, travel sizes only', 'There’s a pharmacy on every corner in Manhattan.',
        ['Toothbrush, paste, deodorant, shampoo', 'Australian sunscreen', 'Razor, clippers, tweezers']],
      ['One pouch holding every cable you own'],
      ['A US power board and multi-port charger'],
      ['Printed photos and one frame'],
      ['Tim Tams for your new flatmates']
    ]},
    { title: 'Leave behind', lede: 'The heaviest, most tempting mistakes.', items: [
      ['Winter gear', 'Buy it in New York in October. Better, cheaper, warmer.',
        ['Down jacket and snow boots', 'Thermals, beanie, scarf, gloves']],
      ['Anything 240V', 'The US runs 120V. A converter costs more than a new one.',
        ['Hair dryer and straightener', 'Kettle and small appliances', 'Australian power boards']],
      ['Bedding, kitchenware, textbooks'],
      ['Shoes four, five and six'],
      ['Anything you haven’t worn in a year', 'You won’t start wearing it in a new country.'],
      ['Food, plants, anything organic', 'US customs will take it and may fine you.']
    ]},
    { title: 'Boxes for home', lede: 'You’ll open these in three years with no memory of packing them.', items: [
      ['One category per box', '',
        ['Winter and off-season clothes', 'Books', 'Electronics and cables', 'Kitchen and homewares', 'Bedding and linen', 'Documents and keepsakes']],
      ['Label the sides, not the top', 'Stacked boxes hide their lids.'],
      ['Photograph each box before you tape it'],
      ['Keep one inventory note'],
      ['Books in small boxes, documents in a plastic tub'],
      ['Vacuum-bag the winter clothes and doonas'],
      ['Mark two boxes “may need posted” and stack them on top']
    ]},
    { title: 'Before you fly', lede: 'The half of moving countries that has nothing to do with suitcases.', items: [
      ['Port your number to a long-expiry prepaid', 'It’s the two-factor on your bank, MyGov and email. Losing it locks you out.'],
      ['Money', '',
        ['Keep one Australian account open', 'Set up Wise and test a small transfer', 'Tell the ATO you’re moving overseas', 'Redirect your mail to your parents’']],
      ['Cancel everything recurring', 'Read three months of statements line by line.',
        ['Gym, in writing', 'Contents and car insurance', 'Opal top-up and subscriptions']],
      ['Dentist and optometrist'],
      ['Leave the room properly', '',
        ['Deep clean', 'Photograph it empty', 'Final inspection and keys back', 'Bond lodged, utilities cancelled']],
      ['Weigh both bags, under 21 kg each'],
      ['Wear the heaviest shoes and jacket onto the plane'],
      ['Book the ride from JFK'],
      ['Say goodbye properly, not in a rush at the door']
    ]}
  ]
};

function seedDoc() {
  const doc = { v: VERSION, meta: { ...SEED.meta }, order: [], sections: {}, items: {}, children: {} };
  SEED.sections.forEach((s) => {
    const sid = uid();
    doc.sections[sid] = { id: sid, title: s.title, lede: s.lede };
    doc.order.push(sid);
    doc.children[sid] = [];
    s.items.forEach(([text, note, kids]) => {
      const id = newItem(doc, text, note || '');
      insertAt(doc, sid, id, null);
      (kids || []).forEach((k) => {
        const cid = newItem(doc, k, '');
        insertAt(doc, id, cid, null);
      });
    });
  });
  return doc;
}

/* =============================================================================
   Layer 2 — store
============================================================================= */

const HISTORY_LIMIT = 80;
const COALESCE_MS = 700;

const store = createStore(
  persist(
    (set, get) => {
      /**
       * The one way state changes.
       * - clones the doc so undo snapshots stay immutable
       * - pushes history, coalescing rapid same-target edits (typing)
       * - optionally carries a focus intent for the view layer to consume
       */
      function commit(mutate, opts = {}) {
        const s = get();
        const before = s.doc;
        const draft = clone(before);
        const out = mutate(draft) || {};
        if (out.abort) return;

        const now = Date.now();
        const key = opts.coalesce || null;
        const merge = key && key === s._ckey && now - s._cat < COALESCE_MS;
        const past = merge ? s.past : [...s.past, before].slice(-HISTORY_LIMIT);

        set({
          doc: draft,
          past,
          future: [],
          _ckey: key,
          _cat: now,
          focus: 'focus' in out ? out.focus : s.focus
        });
      }

      const focusOn = (id, field = 'text', at = 'end') => ({ id, field, at });

      return {
        doc: seedDoc(),
        theme: 'lights-out',
        /* Which rows are showing an empty description field. Session-only, and
           in the store rather than in Row because two different actors open it:
           Shift-Enter inside the row, and the right-click menu outside it. */
        notesOpen: {},
        past: [],
        future: [],
        focus: null,
        _ckey: null,
        _cat: 0,

        /* ---- text ---- */
        setField: (id, field, value) => commit((d) => {
          if (!d.items[id]) return { abort: true };
          d.items[id][field] = value;
        }, { coalesce: `f:${id}:${field}` }),

        setMeta: (field, value) => commit((d) => { d.meta[field] = value; }, { coalesce: `m:${field}` }),

        setSection: (sid, field, value) => commit((d) => {
          if (!d.sections[sid]) return { abort: true };
          d.sections[sid][field] = value;
        }, { coalesce: `s:${sid}:${field}` }),

        /* ---- completion ---- */
        toggle: (id) => commit((d) => {
          const next = stateOf(d, id) !== 'all';
          setDoneDeep(d, id, next);
        }),

        /* ---- structure ---- */
        /** Enter. Splits at the caret, so text to the right moves down with you. */
        addAfter: (id, carry = '') => commit((d) => {
          const it = d.items[id];
          if (!it) return { abort: true };
          const nid = newItem(d, carry, '');
          const siblings = kidsOf(d, it.parent);
          insertAt(d, it.parent, nid, siblings.indexOf(id) + 1);
          return { focus: focusOn(nid, 'text', 'start') };
        }),

        addToSection: (sid) => commit((d) => {
          const nid = newItem(d, '', '');
          insertAt(d, sid, nid, null);
          return { focus: focusOn(nid, 'text', 'start') };
        }),

        /** Enter on an empty child promotes rather than nests deeper. */
        remove: (id, focusId) => commit((d) => {
          if (!d.items[id]) return { abort: true };
          removeDeep(d, id);
          return { focus: focusId ? focusOn(focusId, 'text', 'end') : null };
        }),

        /** Backspace at position 0. Folds this item's text onto the one above. */
        mergeUp: (id) => commit((d) => {
          const flat = flatOf(d);
          const i = flat.findIndex((n) => n.id === id);
          if (i <= 0) return { abort: true };
          const prev = flat[i - 1].id;
          if (kidsOf(d, id).length) return { abort: true };
          const at = d.items[prev].text.length;
          d.items[prev].text += d.items[id].text;
          removeDeep(d, id);
          return { focus: focusOn(prev, 'text', at) };
        }),

        /** Tab. Becomes a child of the sibling above it. */
        indent: (id) => commit((d) => {
          const it = d.items[id];
          if (!it || depthOf(d, id) !== 0 || kidsOf(d, id).length) return { abort: true };
          const sibs = kidsOf(d, it.parent);
          const i = sibs.indexOf(id);
          if (i <= 0) return { abort: true };
          const target = sibs[i - 1];
          const caret = { id, field: 'text', at: 'end' };
          detach(d, id);
          if (!insertAt(d, target, id, null)) return { abort: true };
          return { focus: caret };
        }),

        /** Shift-Tab. Rejoins its parent's level, directly beneath it. */
        outdent: (id) => commit((d) => {
          const it = d.items[id];
          if (!it || depthOf(d, id) !== 1) return { abort: true };
          const parentId = it.parent;
          const grand = d.items[parentId].parent;
          const sibs = kidsOf(d, grand);
          detach(d, id);
          insertAt(d, grand, id, sibs.indexOf(parentId) + 1);
          return { focus: { id, field: 'text', at: 'end' } };
        }),

        /** Option-Up / Option-Down. Reorders within the current level. */
        nudge: (id, dir) => commit((d) => {
          const it = d.items[id];
          if (!it) return { abort: true };
          const sibs = kidsOf(d, it.parent);
          const i = sibs.indexOf(id);
          const j = i + dir;
          if (j < 0 || j >= sibs.length) return { abort: true };
          sibs.splice(i, 1);
          sibs.splice(j, 0, id);
          return { focus: { id, field: 'text', at: 'end' } };
        }),

        /** Drag and drop. `where` is 'before' | 'after' | 'into'. */
        moveTo: (id, targetId, where) => commit((d) => {
          if (id === targetId || !d.items[id] || !d.items[targetId]) return { abort: true };
          // never drop an item inside its own subtree
          if (d.items[targetId].parent === id) return { abort: true };
          const container = where === 'into' ? targetId : d.items[targetId].parent;
          detach(d, id);
          if (where === 'into') {
            if (!insertAt(d, targetId, id, null)) { insertAt(d, d.items[targetId].parent, id, null); }
          } else {
            const sibs = kidsOf(d, container);
            const at = sibs.indexOf(targetId) + (where === 'after' ? 1 : 0);
            if (!insertAt(d, container, id, at)) insertAt(d, d.order[0], id, null);
          }
        }),

        /* ---- sections ---- */
        addSection: () => commit((d) => {
          const sid = uid();
          d.sections[sid] = { id: sid, title: '', lede: '' };
          d.children[sid] = [];
          d.order.push(sid);
          return { focus: { id: sid, field: 'title', at: 'start' } };
        }),

        removeSection: (sid) => commit((d) => {
          kidsOf(d, sid).slice().forEach((id) => removeDeep(d, id));
          delete d.children[sid];
          delete d.sections[sid];
          d.order = d.order.filter((x) => x !== sid);
        }),

        /* ---- history ---- */
        undo: () => {
          const s = get();
          if (!s.past.length) return;
          const prev = s.past[s.past.length - 1];
          set({
            doc: prev,
            past: s.past.slice(0, -1),
            future: [s.doc, ...s.future].slice(0, HISTORY_LIMIT),
            _ckey: null
          });
        },
        redo: () => {
          const s = get();
          if (!s.future.length) return;
          set({
            doc: s.future[0],
            past: [...s.past, s.doc].slice(-HISTORY_LIMIT),
            future: s.future.slice(1),
            _ckey: null
          });
        },

        /* ---- whole-document ---- */
        setFocus: (f) => set({ focus: f }),
        setTheme: (theme) => set({ theme }),

        openNote: (id) => set((s) => ({
          notesOpen: { ...s.notesOpen, [id]: true },
          focus: { id, field: 'note', at: 'end' }
        })),
        closeNote: (id) => set((s) => {
          const next = { ...s.notesOpen };
          delete next[id];
          return { notesOpen: next, focus: { id, field: 'text', at: 'end' } };
        }),
        replaceDoc: (doc) => commit(() => normalise(clone(doc))),
        resetDoc: () => commit(() => seedDoc())
      };
    },
    {
      name: KEY,
      version: VERSION,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ doc: s.doc, theme: s.theme }),   // history and focus are session-only
      migrate: (persisted, from) => {
        if (!persisted || !persisted.doc) return { doc: seedDoc(), theme: 'lights-out' };
        if (from < VERSION) persisted.doc.v = VERSION;
        return persisted;
      },
      merge: (persisted, current) => ({
        ...current,
        doc: persisted && persisted.doc ? normalise(persisted.doc) : current.doc,
        theme: (persisted && persisted.theme) || current.theme
      })
    }
  )
);

/* =============================================================================
   Layer 3 — React bindings
============================================================================= */

const identity = (s) => s;
function useStore(selector = identity) {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState())
  );
}
const act = () => store.getState();

/* caret helpers -------------------------------------------------------------- */

function caretAt(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return 0;
  const r = sel.getRangeAt(0).cloneRange();
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}

function setCaret(el, at) {
  const len = el.textContent.length;
  const pos = at === 'start' ? 0 : at === 'end' ? len : Math.max(0, Math.min(len, at | 0));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = null, offset = 0, acc = 0, n;
  while ((n = walker.nextNode())) {
    if (acc + n.length >= pos) { node = n; offset = pos - acc; break; }
    acc += n.length;
  }
  const r = document.createRange();
  if (node) r.setStart(node, offset);
  else { r.selectNodeContents(el); r.collapse(false); }
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

const hasSelection = () => {
  const s = window.getSelection();
  return s && s.rangeCount > 0 && !s.getRangeAt(0).collapsed;
};

/* =============================================================================
   Layer 4 — view

   Styling is Tailwind utilities resolving to the theme tokens in theme.css.
   No component names a colour directly; they name a role (canvas, ink, muted,
   accent), which is why swapping `data-theme` on <html> restyles all of it.

   Class strings are always complete literals, never assembled from fragments,
   because Tailwind extracts them by scanning this file as text.
============================================================================= */

const THEMES = [
  { id: 'lights-out', name: 'Lights out', bg: '#000000', dot: '#0a84ff' },
  { id: 'off-white',  name: 'Off-white',  bg: '#faf9f6', dot: '#2b2925' },
  { id: 'pastel',     name: 'Pastel',     bg: '#f7f5ff', dot: '#7c6bf5' },
  { id: 'red-eye',    name: 'Red-eye',    bg: '#12100e', dot: '#e9a03c' }
];

const CX = {
  icon: 'shrink-0 w-7 h-7 p-0 border-0 bg-transparent rounded-[7px] flex items-center justify-center ' +
        'text-muted hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent ' +
        'transition-colors cursor-pointer',
  menuItem: 'flex w-full justify-between items-center gap-5 px-2.5 py-1.5 rounded-[7px] border-0 ' +
            'bg-transparent text-ink text-sm text-left cursor-pointer transition-colors ' +
            'hover:bg-accent hover:text-onaccent disabled:opacity-35 disabled:cursor-default ' +
            'disabled:hover:bg-transparent disabled:hover:text-ink'
};

/**
 * Uncontrolled contenteditable.
 *
 * React writes the DOM exactly twice: on mount, and when the value changes
 * from somewhere other than this element (undo, import, a merge). Any other
 * write would collapse the caret to position 0 on every keystroke.
 */
const Editable = memo(function Editable({
  value, onChange, onKeyDown, onContextMenu, className, placeholder, tag = 'div', focusAt, onFocused, testId
}) {
  const ref = useRef(null);
  const mine = useRef(value);

  const attach = useCallback((el) => {
    ref.current = el;
    if (!el) return;
    try { el.setAttribute('contenteditable', 'plaintext-only'); }
    catch (e) { el.setAttribute('contenteditable', 'true'); }
    if (!el.isContentEditable) el.setAttribute('contenteditable', 'true');
    el.textContent = mine.current;
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value !== mine.current && el.textContent !== value) {
      const active = document.activeElement === el;
      const pos = active ? caretAt(el) : null;
      el.textContent = value;
      if (active) setCaret(el, Math.min(pos, value.length));
    }
    mine.current = value;
  }, [value]);

  useLayoutEffect(() => {
    if (focusAt == null || !ref.current) return;
    ref.current.focus({ preventScroll: false });
    setCaret(ref.current, focusAt);
    onFocused && onFocused();
  }, [focusAt]);

  return html`<${tag}
    ref=${attach}
    className=${className}
    data-t=${testId || null}
    data-ph=${placeholder || ''}
    suppressContentEditableWarning=${true}
    spellCheck=${false}
    onInput=${(e) => { mine.current = e.currentTarget.textContent; onChange(mine.current); }}
    onPaste=${(e) => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t.replace(/\r?\n/g, ' '));
    }}
    onContextMenu=${onContextMenu}
    onKeyDown=${onKeyDown}
  />`;
});

/** Selects this row's focus intent as a primitive so other rows never re-render. */
function useFocusAt(id, field) {
  return useStore((s) => (s.focus && s.focus.id === id && s.focus.field === field ? s.focus.at : null));
}
const clearFocus = () => act().setFocus(null);

/* ---- one row --------------------------------------------------------------- */

function Row({ id, depth, drag, first }) {
  const text = useStore((s) => s.doc.items[id].text);
  const note = useStore((s) => s.doc.items[id].note);
  const mark = useStore((s) => stateOf(s.doc, id));
  const kids = useStore((s) => s.doc.children[id]);
  const focusText = useFocusAt(id, 'text');
  const focusNote = useFocusAt(id, 'note');
  const noteOpen = useStore((s) => !!s.notesOpen[id]);
  const sub = depth === 1;

  const neighbours = useCallback(() => {
    const d = store.getState().doc;
    const flat = flatOf(d);
    const i = flat.findIndex((n) => n.id === id);
    return { prev: i > 0 ? flat[i - 1].id : null, next: i < flat.length - 1 ? flat[i + 1].id : null };
  }, [id]);



  const onTextKey = (e) => {
    const el = e.currentTarget;
    const s = act();
    const pos = caretAt(el);
    const len = el.textContent.length;
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key === 'Enter') { e.preventDefault(); s.toggle(id); return; }
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? s.redo() : s.undo();
      return;
    }

    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); s.openNote(id); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!len && depth === 1) { s.outdent(id); return; }
      const carry = el.textContent.slice(pos);
      if (carry) s.setField(id, 'text', el.textContent.slice(0, pos));
      s.addAfter(id, carry);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      e.shiftKey ? s.outdent(id) : s.indent(id);
      return;
    }
    if (e.key === 'Backspace' && pos === 0 && !hasSelection()) {
      const { prev } = neighbours();
      if (!prev) return;
      e.preventDefault();
      if (!len && !(kids && kids.length)) s.remove(id, prev);
      else s.mergeUp(id);
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      s.nudge(id, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowUp' && pos === 0) {
      const { prev } = neighbours();
      if (prev) { e.preventDefault(); s.setFocus({ id: prev, field: 'text', at: 'end' }); }
      return;
    }
    if (e.key === 'ArrowDown' && pos === len) {
      const { next } = neighbours();
      if (next) { e.preventDefault(); s.setFocus({ id: next, field: 'text', at: 'start' }); }
      return;
    }
    if (e.key === 'Escape') el.blur();
  };

  const onNoteKey = (e) => {
    const el = e.currentTarget;
    const s = act();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); s.addAfter(id, ''); return; }
    if (e.key === 'Backspace' && caretAt(el) === 0 && !el.textContent.length) {
      e.preventDefault();
      s.setField(id, 'note', '');
      s.closeNote(id);
      return;
    }
    if (e.key === 'Escape') el.blur();
  };

  const noteVisible = note.length > 0 || noteOpen;

  const liClass = sub
    ? 'p-0'
    : (first ? 'p-0' : 'p-0 border-t border-hairline');

  const rowClass =
    (sub ? 'group/row relative flex items-start gap-4 py-[5px] ' : 'group/row relative flex items-start gap-4 py-[13px] ') +
    (drag.hint.id === id ? (drag.hint.where === 'above' ? 'drop-above' : 'drop-below') : '');

  const txtClass = sub
    ? (mark === 'all' ? 'text-[15px] text-faint break-words transition-colors' : 'text-[15px] text-muted break-words transition-colors')
    : (mark === 'all' ? 'text-muted break-words transition-colors' : 'break-words transition-colors');

  return html`
    <li data-t="node" data-depth=${depth}
        className=${liClass + (drag.draggingId === id ? ' opacity-40' : '')}
        draggable=${drag.armed === id}
        onDragStart=${(e) => drag.start(e, id)}
        onDragEnd=${drag.end}
        onDragOver=${(e) => drag.over(e, id)}
        onDrop=${(e) => drag.drop(e, id)}>
      <div data-t="row" className=${rowClass} onContextMenu=${(e) => menuBus.open(e, id)}>
        <button
          className=${'tick shrink-0 cursor-pointer ' +
            (sub ? 'sm w-[18px] h-[18px] mt-[2px] ' : 'w-[22px] h-[22px] mt-px ') +
            (mark === 'all' ? 'on' : mark === 'some' ? 'part' : '')}
          aria-label="Toggle"
          onClick=${() => act().toggle(id)} />

        <div className="flex-1 min-w-0 pt-px">
          <${Editable}
            tag="div"
            testId="txt"
            className=${txtClass}
            value=${text}
            placeholder=${sub ? 'Sub-item' : 'New item'}
            focusAt=${focusText}
            onFocused=${clearFocus}
            onChange=${(v) => act().setField(id, 'text', v)}
            onContextMenu=${(e) => menuBus.open(e, id)}
            onKeyDown=${onTextKey} />
          ${noteVisible && html`
            <${Editable}
              tag="div"
              testId="note"
              className=${sub
                ? 'block text-[14px] text-muted mt-[3px] tracking-[-0.01em] break-words'
                : 'block text-[15px] text-muted mt-[3px] tracking-[-0.01em] break-words'}
              value=${note}
              placeholder="Add a description"
              focusAt=${focusNote}
              onFocused=${clearFocus}
              onChange=${(v) => act().setField(id, 'note', v)}
              onKeyDown=${onNoteKey} />`}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          <div className="flex h-[26px] w-[22px] cursor-grab items-center justify-center rounded-md text-sm text-faint hover:bg-hover hover:text-muted active:cursor-grabbing"
               title="Drag to move"
               onMouseDown=${() => drag.arm(id)}
               onMouseUp=${() => drag.arm(null)}>⠿</div>
          <button className=${CX.icon} title="More" onClick=${(e) => menuBus.open(e, id)}>⋯</button>
        </div>
      </div>

      ${kids && kids.length ? html`
        <ul data-t="kids" className="mt-2 mb-1.5 ml-[38px] p-0 list-none">
          ${kids.map((cid) => html`<${Row} key=${cid} id=${cid} depth=${1} drag=${drag} first=${true} />`)}
        </ul>` : null}
    </li>`;
}

/* ---- right-click menu ------------------------------------------------------
   A single menu instance at the app root rather than one per row. Rows publish
   an open request through this bus; only the root re-renders.
--------------------------------------------------------------------------- */

const menuBus = {
  listener: null,
  open(e, id) {
    e.preventDefault();
    e.stopPropagation();
    this.listener && this.listener({ id, x: e.clientX, y: e.clientY });
  }
};

function ContextMenu({ ctx, onClose, onAddNote }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!ctx || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(ctx.x, window.innerWidth - r.width - 12),
      y: Math.min(ctx.y, window.innerHeight - r.height - 12)
    });
  }, [ctx]);

  useEffect(() => {
    if (!ctx) return;
    const away = () => onClose();
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('click', away);
    window.addEventListener('keydown', esc);

    /* Close on scroll, because the menu is anchored to viewport coordinates and
       would otherwise float over unrelated rows. But arm it two frames late:
       right-clicking a row near the edge scrolls it into view, and that scroll
       would otherwise shut the menu the instant it opened. */
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => window.addEventListener('scroll', away, true));
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('click', away);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', away, true);
    };
  }, [ctx]);

  if (!ctx) return null;

  const d = store.getState().doc;
  const item = d.items[ctx.id];
  if (!item) return null;

  const hasNote = item.note.length > 0;
  const depth = depthOf(d, ctx.id);
  const done = stateOf(d, ctx.id) === 'all';
  const run = (fn) => () => { fn(); onClose(); };
  const s = act();

  return html`
    <div ref=${ref} data-t="ctx"
         onClick=${(e) => e.stopPropagation()}
         onContextMenu=${(e) => { e.preventDefault(); e.stopPropagation(); }}
         style=${{ left: pos.x + 'px', top: pos.y + 'px' }}
         className="fixed z-[90] min-w-[224px] rounded-xl border border-hairline bg-surface/95 p-1.5
                    shadow-2xl backdrop-blur-xl backdrop-saturate-150">
      <button className=${CX.menuItem} onClick=${run(() => onAddNote(ctx.id))}>
        ${hasNote ? 'Edit description' : 'Add description'}<kbd className="text-xs opacity-60">⇧↵</kbd>
      </button>
      <button className=${CX.menuItem} onClick=${run(() => s.toggle(ctx.id))}>
        ${done ? 'Mark as not done' : 'Mark as done'}<kbd className="text-xs opacity-60">⌘↵</kbd>
      </button>
      <div className="mx-2 my-1.5 h-px bg-hairline" />
      <button className=${CX.menuItem}
              onClick=${run(() => s.setFocus({ id: ctx.id, field: 'text', at: 'end' }))}>
        Rename
      </button>
      <button className=${CX.menuItem} disabled=${depth === 1}
              onClick=${run(() => s.addAfter(ctx.id, ''))}>
        Add item below<kbd className="text-xs opacity-60">↵</kbd>
      </button>
      <button className=${CX.menuItem} disabled=${depth !== 0}
              onClick=${run(() => s.indent(ctx.id))}>
        Indent<kbd className="text-xs opacity-60">⇥</kbd>
      </button>
      <button className=${CX.menuItem} disabled=${depth !== 1}
              onClick=${run(() => s.outdent(ctx.id))}>
        Outdent<kbd className="text-xs opacity-60">⇧⇥</kbd>
      </button>
      <div className="mx-2 my-1.5 h-px bg-hairline" />
      <button className=${CX.menuItem} onClick=${run(() => s.nudge(ctx.id, -1))}>
        Move up<kbd className="text-xs opacity-60">⌥↑</kbd>
      </button>
      <button className=${CX.menuItem} onClick=${run(() => s.nudge(ctx.id, 1))}>
        Move down<kbd className="text-xs opacity-60">⌥↓</kbd>
      </button>
      <div className="mx-2 my-1.5 h-px bg-hairline" />
      <button className=${CX.menuItem}
              onClick=${run(() => {
                const flat = flatOf(store.getState().doc);
                const i = flat.findIndex((n) => n.id === ctx.id);
                s.remove(ctx.id, i > 0 ? flat[i - 1].id : null);
              })}>
        Delete<kbd className="text-xs opacity-60">⌫</kbd>
      </button>
    </div>`;
}

/* ---- section --------------------------------------------------------------- */

function Section({ sid, drag, first }) {
  const title = useStore((s) => s.doc.sections[sid].title);
  const lede = useStore((s) => s.doc.sections[sid].lede);
  const ids = useStore((s) => s.doc.children[sid]);
  const focusTitle = useFocusAt(sid, 'title');

  return html`
    <section className=${first ? 'pt-[72px] group/sec' : 'pt-[72px] mt-[72px] group/sec'}>
      <div className="mb-[34px]">
        <div className="flex items-start gap-2">
          <${Editable}
            tag="h2"
            className="font-display text-4xl font-semibold tracking-[-0.022em] mb-2"
            value=${title}
            placeholder="Section"
            focusAt=${focusTitle}
            onFocused=${clearFocus}
            onChange=${(v) => act().setSection(sid, 'title', v)}
            onKeyDown=${(e) => {
              if (e.key === 'Enter') { e.preventDefault(); act().addToSection(sid); }
              if (e.key === 'Escape') e.currentTarget.blur();
            }} />
          <button className=${CX.icon + ' mt-2 opacity-0 group-hover/sec:opacity-100'}
                  title="Delete section"
                  onClick=${() => {
                    const n = (store.getState().doc.children[sid] || []).length;
                    if (!n || window.confirm(`Delete this section and its ${n} item${n === 1 ? '' : 's'}?`)) {
                      act().removeSection(sid);
                    }
                  }}>✕</button>
        </div>
        <${Editable}
          tag="div"
          className="text-[19px] text-muted tracking-[-0.015em] max-w-[520px]"
          value=${lede}
          placeholder="Add a description"
          onChange=${(v) => act().setSection(sid, 'lede', v)}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') { e.preventDefault(); act().addToSection(sid); }
            if (e.key === 'Escape') e.currentTarget.blur();
          }} />
      </div>

      <ul className="list-none m-0 p-0">
        ${(ids || []).map((id, i) => html`
          <${Row} key=${id} id=${id} depth=${0} drag=${drag} first=${i === 0} />`)}
      </ul>

      <div data-t="add" className="group/add mt-3.5 flex cursor-pointer select-none items-center gap-3 py-1.5 text-[15px] text-faint transition-colors hover:text-accent"
           onClick=${() => act().addToSection(sid)}>
        <div className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px] border-dashed border-current text-[13px] leading-none group-hover/add:border-solid">+</div>
        <span>Add item</span>
      </div>
    </section>`;
}

/* ---- drag and drop --------------------------------------------------------- */

function useDrag() {
  const [armed, setArmed] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [hint, setHint] = useState({ id: null, where: null });

  return {
    armed, draggingId, hint,
    arm: setArmed,
    start(e, id) {
      setDraggingId(id);
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', id); } catch (err) {}
    },
    end() { setDraggingId(null); setArmed(null); setHint({ id: null, where: null }); },
    over(e, id) {
      if (!draggingId || draggingId === id) return;
      e.preventDefault();
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      const where = (e.clientY - r.top) / r.height < 0.5 ? 'above' : 'below';
      if (hint.id !== id || hint.where !== where) setHint({ id, where });
    },
    drop(e, id) {
      if (!draggingId || draggingId === id) return;
      e.preventDefault();
      e.stopPropagation();
      act().moveTo(draggingId, id, hint.where === 'above' ? 'before' : 'after');
      this.end();
    }
  };
}

/* ---- chrome ---------------------------------------------------------------- */

function ThemePicker() {
  const theme = useStore((s) => s.theme);
  return html`
    <div className="px-2.5 pt-2 pb-1">
      <div className="mb-2 text-xs text-muted">Theme</div>
      <div className="flex items-center gap-2.5">
        ${THEMES.map((t) => html`
          <button key=${t.id}
                  className="swatch"
                  title=${t.name}
                  aria-pressed=${theme === t.id}
                  style=${{ background: t.bg }}
                  onClick=${() => act().setTheme(t.id)}>
            <i style=${{ background: t.dot }} />
          </button>`)}
      </div>
      <div className="mt-2 text-xs text-faint">
        ${(THEMES.find((t) => t.id === theme) || THEMES[0]).name}
      </div>
    </div>`;
}

function Menu({ open, onClose }) {
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = () => onClose();
    window.addEventListener('click', away);
    return () => window.removeEventListener('click', away);
  }, [open]);

  if (!open) return null;

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(store.getState().doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'checklist.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const importJSON = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try { act().replaceDoc(JSON.parse(r.result)); }
      catch (err) { window.alert('That file is not a valid checklist.'); }
    };
    r.readAsText(f);
  };

  return html`
    <div className="absolute right-0 top-[34px] z-[70] min-w-[240px] rounded-xl border border-hairline
                    bg-surface/90 p-1.5 shadow-2xl backdrop-blur-xl backdrop-saturate-150"
         onClick=${(e) => e.stopPropagation()}>
      <${ThemePicker} />
      <div className="mx-2 my-1.5 h-px bg-hairline" />
      <button className=${CX.menuItem} disabled=${!canUndo} onClick=${() => act().undo()}>
        Undo<kbd className="text-xs text-muted">⌘Z</kbd>
      </button>
      <button className=${CX.menuItem} disabled=${!canRedo} onClick=${() => act().redo()}>
        Redo<kbd className="text-xs text-muted">⇧⌘Z</kbd>
      </button>
      <div className="mx-2 my-1.5 h-px bg-hairline" />
      <button className=${CX.menuItem} onClick=${exportJSON}>
        Export a copy<kbd className="text-xs text-muted">.json</kbd>
      </button>
      <button className=${CX.menuItem} onClick=${() => fileRef.current.click()}>Import a copy</button>
      <input type="file" accept="application/json" ref=${fileRef}
             className="hidden" onChange=${importJSON} />
      <div className="mx-2 my-1.5 h-px bg-hairline" />
      <button className=${CX.menuItem}
              onClick=${() => { if (window.confirm('Discard your edits and restore the original checklist?')) act().resetDoc(); }}>
        Restore original
      </button>
      <div className="mx-2 my-1.5 h-px bg-hairline" />
      <div className="px-2.5 pb-2 pt-1.5 text-xs leading-relaxed text-muted">
        ${safeStorage.live
          ? 'Saved on this device automatically.'
          : 'This browser is blocking storage, so changes last for this session only. Export a copy to keep them.'}
      </div>
    </div>`;
}

function Bar() {
  const title = useStore((s) => s.doc.meta.title);
  const { done, total } = useStore((s) => tallyOf(s.doc));
  const [stuck, setStuck] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return html`
    <${Fragment}>
      <div className="fixed inset-x-0 top-0 z-[60] h-0.5">
        <div className="h-full bg-accent transition-[width] duration-300 ease-out"
             style=${{ width: (total ? (done / total) * 100 : 0) + '%' }} />
      </div>
      <div className=${'sticky top-0 z-50 border-b bg-canvas/75 backdrop-blur-xl backdrop-saturate-150 transition-colors ' +
                       (stuck ? 'border-hairline' : 'border-transparent')}>
        <div className="mx-auto flex h-12 max-w-[700px] items-center gap-3.5 px-7 text-[13px] tracking-normal">
          <span className="min-w-0 flex-1 truncate font-medium">${title.replace(/\n/g, ' ')}</span>
          <span data-t="count" className="text-muted tabular-nums">${done} of ${total}</span>
          <div className="relative">
            <button className=${CX.icon} title="More"
                    onClick=${(e) => { e.stopPropagation(); setMenu(!menu); }}>⋯</button>
            <${Menu} open=${menu} onClose=${() => setMenu(false)} />
          </div>
        </div>
      </div>
    <//>`;
}

function Hero() {
  const title = useStore((s) => s.doc.meta.title);
  const sub = useStore((s) => s.doc.meta.sub);
  const when = useStore((s) => s.doc.meta.when);
  const esc = (e) => { if (e.key === 'Escape') e.currentTarget.blur(); };
  return html`
    <div className="pt-[120px] pb-24 text-center">
      <${Editable} tag="h1"
        className="font-display text-[56px] font-semibold leading-[1.05] tracking-[-0.025em] mb-5 whitespace-pre-wrap"
        value=${title} placeholder="Title" onKeyDown=${esc}
        onChange=${(v) => act().setMeta('title', v)} />
      <${Editable} tag="div"
        className="mx-auto max-w-[470px] text-[21px] leading-[1.4] tracking-[-0.015em] text-muted"
        value=${sub} placeholder="Subtitle" onKeyDown=${esc}
        onChange=${(v) => act().setMeta('sub', v)} />
      <${Editable} tag="div"
        className="mt-11 text-[13px] uppercase tracking-[0.08em] text-muted"
        value=${when} placeholder="Date" onKeyDown=${esc}
        onChange=${(v) => act().setMeta('when', v)} />
    </div>`;
}

function App() {
  const order = useStore((s) => s.doc.order);
  const theme = useStore((s) => s.theme);
  const drag = useDrag();
  const [ctx, setCtx] = useState(null);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  useEffect(() => {
    menuBus.listener = setCtx;
    return () => { menuBus.listener = null; };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const el = document.activeElement;
      if (el && el.isContentEditable) return;
      e.preventDefault();
      e.shiftKey ? act().redo() : act().undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const addNote = useCallback((id) => act().openNote(id), []);

  return html`
    <${Fragment}>
      <${Bar} />
      <main className="mx-auto max-w-[700px] px-7 pb-[200px]">
        <${Hero} />
        ${order.map((sid, i) => html`
          <${Section} key=${sid} sid=${sid} drag=${drag} first=${i === 0} />`)}
        <button className="mx-auto mt-[72px] block border-0 bg-transparent p-2.5 text-sm text-faint
                           cursor-pointer transition-colors hover:text-accent"
                onClick=${() => act().addSection()}>+ Add section</button>
      </main>
      <footer className="mx-auto max-w-[700px] px-7 pb-[90px] pt-14 text-center text-[13px] leading-relaxed text-muted">
        Based on NYU’s packing guidance for international students.
        <div className="mt-2.5 text-xs text-faint">
          Right-click any item for descriptions and more ·
          <kbd className="mx-px rounded border border-hairline px-1.5 text-[11px]">↵</kbd> new ·
          <kbd className="mx-px rounded border border-hairline px-1.5 text-[11px]">⇥</kbd> indent ·
          <kbd className="mx-px rounded border border-hairline px-1.5 text-[11px]">⇧↵</kbd> description ·
          <kbd className="mx-px rounded border border-hairline px-1.5 text-[11px]">⌘Z</kbd> undo
        </div>
      </footer>
      <${ContextMenu} ctx=${ctx} onClose=${() => setCtx(null)} onAddNote=${addNote} />
    <//>`;
}

export default App;
