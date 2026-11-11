/**
 * The harness page: one self-contained document with its own style and script.
 * No framework, no CDN, no network beyond the harness server, so it works
 * offline. The script is plain browser JavaScript kept in a raw string: it
 * uses no backtick and no dollar-brace, so nothing in it can be mistaken for a
 * template. The page relays the framed application's bridge messages to the
 * session (/_dev/message) and posts the session's replies back into the frame;
 * everything else is a view of the session state it receives as server events.
 */

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>screenRIG app dev</title>
<link rel="stylesheet" href="/_dev/harness.css">
</head>
<body>
<header id="top">
  <div class="brand">screenRIG <span>app dev</span></div>
  <div id="pills" class="pills"></div>
  <div class="actions">
    <button id="btn-restart" type="button" title="End this activation and start a new one (a new generation)">Restart activation</button>
    <button id="btn-reload" type="button" title="Load the application's files again">Reload</button>
  </div>
</header>
<div id="banners"></div>
<main>
  <section id="stage-area">
    <div id="stage-meta" class="muted"></div>
    <div id="stage"><div id="frame-box"></div></div>
  </section>
  <aside id="side">
    <nav id="tabs" role="tablist"></nav>
    <div id="panels"></div>
  </aside>
</main>
<script src="/_dev/harness.js"></script>
</body>
</html>
`;

const CSS = String.raw`:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #ffffff; --ink: #14181f; --muted: #5d6675; --line: #d8dde5;
  --accent: #1f6feb; --accent-ink: #ffffff; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --code: #eef1f5;
  --font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --small: 12px;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0e1116; --panel: #161b22; --ink: #e6e9ee; --muted: #9aa4b2; --line: #2b323c; --accent: #4493f8; --accent-ink: #0b0f14; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --code: #1d232c; }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--ink); font: var(--font); display: flex; flex-direction: column; }
header#top { display: flex; align-items: center; gap: 16px; padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.brand { font-weight: 650; }
.brand span { color: var(--muted); font-weight: 400; }
.pills { display: flex; gap: 8px; flex-wrap: wrap; flex: 1; }
.pill { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-size: var(--small); color: var(--muted); background: var(--bg); }
.pill.ok { color: var(--ok); border-color: var(--ok); }
.pill.warn { color: var(--warn); border-color: var(--warn); }
.pill.bad { color: var(--bad); border-color: var(--bad); }
.actions { display: flex; gap: 8px; }
button, select, input[type=text], input[type=number], textarea { font: inherit; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; }
button { cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.small { padding: 2px 8px; font-size: var(--small); }
input[type=number] { width: 7em; }
input[type=text] { min-width: 0; }
textarea { width: 100%; min-height: 5.5em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--small); }
#banners { display: flex; flex-direction: column; }
.banner { padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
.banner.bad { border-left: 4px solid var(--bad); }
.banner.warn { border-left: 4px solid var(--warn); }
.banner.ok { border-left: 4px solid var(--ok); }
.banner strong { margin-right: 8px; }
.banner code { background: var(--code); border-radius: 4px; padding: 1px 5px; }
main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 460px; gap: 16px; padding: 16px; }
@media (max-width: 1100px) { main { grid-template-columns: minmax(0, 1fr); } }
#stage-area { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
#stage { flex: 1; min-height: 240px; background: repeating-conic-gradient(var(--line) 0 25%, var(--panel) 0 50%) 0 0 / 20px 20px; border: 1px solid var(--line); border-radius: 8px; overflow: auto; padding: 12px; }
#frame-box { position: relative; background: #000; box-shadow: 0 0 0 1px var(--line); }
#frame-box iframe { position: absolute; left: 0; top: 0; border: 0; background: #fff; transform-origin: 0 0; }
.muted { color: var(--muted); font-size: var(--small); }
aside#side { min-width: 0; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
nav#tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 8px 8px 0; border-bottom: 1px solid var(--line); }
nav#tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 6px 10px; color: var(--muted); }
nav#tabs button[aria-selected=true] { color: var(--ink); border-bottom-color: var(--accent); }
#panels { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
.panel { display: none; flex-direction: column; gap: 16px; }
.panel.on { display: flex; }
.group { display: flex; flex-direction: column; gap: 8px; }
.group > h3 { margin: 0; font-size: var(--font); font-weight: 650; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row label { display: inline-flex; align-items: center; gap: 6px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; }
.list { display: flex; flex-direction: column; gap: 6px; }
.item { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.item .head { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--small); }
.status { min-height: 1.4em; font-size: var(--small); color: var(--muted); }
.status.bad { color: var(--bad); }
.log { display: flex; flex-direction: column; gap: 2px; }
.entry { display: grid; grid-template-columns: 5.5em 9em 1fr; gap: 8px; font-size: var(--small); padding: 2px 0; border-bottom: 1px dashed var(--line); }
.entry .t { color: var(--muted); }
.entry .k { font-weight: 600; overflow-wrap: anywhere; }
.entry.error .k { color: var(--bad); }
.entry.warn .k { color: var(--warn); }
.entry.debug { opacity: .7; }
.entry details > summary { cursor: pointer; color: var(--muted); }
.entry pre { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--code); border-radius: 4px; padding: 6px; }
table.kv { width: 100%; border-collapse: collapse; font-size: var(--small); }
table.kv th, table.kv td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
`;

const SCRIPT = String.raw`(function () {
  'use strict';

  var state = null;
  var logEntries = [];
  var frame = null;
  var frameSrc = '';
  var connectedBefore = false;
  var showDebug = false;
  var relayQueue = Promise.resolve();

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (name) {
        var value = attrs[name];
        if (value === undefined || value === null || value === false) return;
        if (name === 'class') node.className = value;
        else if (name === 'text') node.textContent = value;
        else if (name.slice(0, 2) === 'on') node.addEventListener(name.slice(2), value);
        else node.setAttribute(name, value === true ? '' : String(value));
      });
    }
    function add(child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) { child.forEach(add); return; }
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    for (var i = 2; i < arguments.length; i += 1) add(arguments[i]);
    return node;
  }

  function $(id) { return document.getElementById(id); }

  function send(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (response) { return response.json().then(function (json) { return { status: response.status, json: json }; }); });
  }

  function command(body, statusId) {
    return send('/_dev/command', body).then(function (answer) {
      if (statusId) setStatus(statusId, answer.json.ok ? '' : answer.json.error, !answer.json.ok);
      return answer.json;
    }, function (error) {
      if (statusId) setStatus(statusId, String(error), true);
    });
  }

  function setStatus(id, text, bad) {
    var node = $(id);
    if (!node) return;
    node.textContent = text || '';
    node.className = bad ? 'status bad' : 'status';
  }

  function fire(trigger, statusId) {
    return command({ command: 'trigger', trigger: trigger }, statusId).then(function (answer) {
      if (answer && answer.ok && statusId) {
        var result = answer.result || {};
        setStatus(statusId, result.posted ? 'Sent.' : 'Not sent' + (result.dropped ? ': ' + result.dropped : '.') + (result.consumed === true ? ' The Player keeps the input.' : ''));
      }
    });
  }

  // The frame.

  function mountFrame(src, allow) {
    frameSrc = src;
    var box = $('frame-box');
    if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
    frame = document.createElement('iframe');
    frame.title = 'Application';
    // The permissions of a frame are fixed when it loads: camera and microphone only while device.hdmi_input is granted.
    frame.setAttribute('allow', allow || (state && state.frame_allow) || 'autoplay; fullscreen; clipboard-read; clipboard-write');
    frame.addEventListener('load', function () { command({ command: 'frame-loaded' }); });
    frame.src = src;
    box.appendChild(frame);
    layoutFrame();
  }

  function layoutFrame() {
    if (!state || !frame) return;
    var width = state.viewport.width;
    var height = state.viewport.height;
    var stage = $('stage');
    var room = Math.max(160, stage.clientWidth - 24);
    var tall = Math.max(160, window.innerHeight - 220);
    var scale = Math.min(1, room / width, tall / height);
    var box = $('frame-box');
    box.style.width = Math.round(width * scale) + 'px';
    box.style.height = Math.round(height * scale) + 'px';
    frame.style.width = width + 'px';
    frame.style.height = height + 'px';
    frame.style.transform = 'scale(' + scale + ')';
    $('stage-meta').textContent = width + ' x ' + height + ' at ' + Math.round(scale * 100) + '%  |  ' + state.app_origin;
  }

  window.addEventListener('resize', layoutFrame);

  window.addEventListener('message', function (event) {
    if (!frame || event.source !== frame.contentWindow || !state || event.origin !== state.app_origin) return;
    var body = { data: event.data, origin: event.origin };
    relayQueue = relayQueue.then(function () { return send('/_dev/message', body); }).then(function () {}, function () {});
  });

  function toFrame(message) {
    if (frame && frame.contentWindow && state) frame.contentWindow.postMessage(message, state.app_origin);
  }

  // Server events.

  function connect() {
    var source = new EventSource('/_dev/events');
    source.addEventListener('open', function () {
      if (connectedBefore && state) mountFrame(state.frame_src, state.frame_allow);
      connectedBefore = true;
    });
    source.addEventListener('state', function (event) {
      var next = JSON.parse(event.data);
      if (next.log) { logEntries = next.log; delete next.log; }
      var first = state === null;
      state = next;
      if (first) mountFrame(state.frame_src, state.frame_allow);
      render();
    });
    source.addEventListener('bridge', function (event) { toFrame(JSON.parse(event.data)); });
    source.addEventListener('log', function (event) {
      logEntries.push(JSON.parse(event.data));
      if (logEntries.length > 500) logEntries.shift();
      renderLog();
    });
    source.addEventListener('frame', function (event) {
      var message = JSON.parse(event.data);
      if (state) { state.frame_src = message.src; state.frame_allow = message.allow; }
      mountFrame(message.src, message.allow);
    });
  }

  // Rendering.

  function pill(text, kind) { return el('span', { class: 'pill ' + (kind || ''), text: text }); }

  function renderTop() {
    var host = state.host;
    var pills = $('pills');
    pills.textContent = '';
    var activation = host.active ? ['active, generation ' + host.generation, 'ok'] : state.release ? ['waiting for the handshake', 'warn'] : ['no release', 'bad'];
    pills.appendChild(pill(activation[0], activation[1]));
    if (host.ready) pills.appendChild(pill('ready', 'ok'));
    if (host.ended) pills.appendChild(pill('page ended: ' + host.ended, 'warn'));
    if (host.held.length) pills.appendChild(pill('held: ' + host.held.join(', '), 'warn'));
    pills.appendChild(pill(state.release ? 'release ' + state.release.revision + ', ' + state.release.file_count + ' files' : 'not built', state.release ? '' : 'bad'));
    pills.appendChild(pill('kv: ' + state.kv.mode + (state.kv.mode === 'remote' ? ' (read-only)' : ''), ''));
  }

  function renderBanners() {
    var box = $('banners');
    box.textContent = '';
    if (state.refusal) {
      var refusal = state.refusal;
      var where = refusal.file ? ' ' + refusal.file + (refusal.line ? ':' + refusal.line : '') : '';
      box.appendChild(el('div', { class: 'banner bad' },
        el('strong', { text: 'app pack would refuse this directory' }), el('code', { text: refusal.code }),
        el('div', { text: refusal.detail + (where && refusal.detail.indexOf(refusal.file || '\u0000') < 0 ? ' (' + where.trim() + ')' : '') }),
        el('div', { class: 'muted', text: state.release ? 'The last accepted build is still served.' : 'Nothing is served until the directory is accepted.' })));
    }
    if (state.changed_since_load) {
      box.appendChild(el('div', { class: 'banner warn' }, el('strong', { text: 'Files changed.' }), 'Automatic reload is off. ', el('button', { class: 'small', type: 'button', text: 'Reload now', onclick: function () { command({ command: 'reload' }); } })));
    }
    if (state.host.ended) {
      var names = { advance: 'The application called nextPage(): the Player moves to the next page.', skip: 'The application called skip(): the Player leaves the page without counting a play.', max_ms: 'The page reached max_ms: the Player moves on.' };
      box.appendChild(el('div', { class: 'banner ok' }, el('strong', { text: 'Page ended.' }), names[state.host.ended] || '', state.loop ? ' Starting over.' : ' ', state.loop ? null : el('button', { class: 'small', type: 'button', text: 'Start again', onclick: function () { command({ command: 'restart' }); } })));
    }
  }

  function field(label, input, extra) {
    return el('label', { class: 'row' }, el('span', { class: 'muted', text: label }), input, extra || null);
  }

  var controls = {};

  function control(id, node) { controls[id] = node; return node; }

  function setIfIdle(node, value) {
    if (document.activeElement !== node) node.value = value;
  }

  // Panels.

  var panelDefs = [];

  function addPanel(id, title, build) { panelDefs.push({ id: id, title: title, build: build }); }

  function group(title) {
    var box = el('div', { class: 'group' }, el('h3', { text: title }));
    for (var i = 1; i < arguments.length; i += 1) if (arguments[i]) box.appendChild(arguments[i]);
    return box;
  }

  function statusLine(id) { return el('div', { class: 'status', id: id }); }

  addPanel('launch', 'Launch', function () {
    var preset = control('preset', el('select', { id: 'preset' },
      el('option', { value: '1920x1080', text: '1920 x 1080' }), el('option', { value: '3840x2160', text: '3840 x 2160' }),
      el('option', { value: '1080x1920', text: '1080 x 1920 (portrait)' }), el('option', { value: 'custom', text: 'Custom' })));
    var width = control('width', el('input', { type: 'number', id: 'width', min: 1, max: 8192 }));
    var height = control('height', el('input', { type: 'number', id: 'height', min: 1, max: 8192 }));
    function applySize() {
      var parts = preset.value.split('x');
      var w = preset.value === 'custom' ? Number(width.value) : Number(parts[0]);
      var h = preset.value === 'custom' ? Number(height.value) : Number(parts[1]);
      command({ command: 'viewport', width: w, height: h }, 'size-status');
    }
    preset.addEventListener('change', applySize);
    var name = control('screen-name', el('input', { type: 'text', id: 'screen-name', placeholder: 'Lobby East' }));
    var zone = control('screen-zone', el('input', { type: 'text', id: 'screen-zone', placeholder: 'America/Vancouver' }));
    var params = control('params', el('textarea', { id: 'params', spellcheck: 'false', placeholder: 'name=value, one per line' }));
    function apply() {
      var out = {};
      params.value.split('\n').forEach(function (line) {
        var at = line.indexOf('=');
        if (line.trim() === '' || at < 1) return;
        out[line.slice(0, at).trim()] = line.slice(at + 1);
      });
      command({ command: 'launch', name: name.value, timezone: zone.value, params: out }, 'launch-status');
    }
    return [
      group('Viewport and primitive', el('div', { class: 'row' }, preset, width, 'x', height, el('button', { type: 'button', text: 'Resize', onclick: applySize })), statusLine('size-status'),
        el('div', { class: 'muted', text: 'The application sees this size as its viewport and its primitive. A resize sends viewport.changed.' })),
      group('Screen and launch params', field('Screen name', name), field('Time zone', zone), params,
        el('div', { class: 'row' }, el('button', { class: 'primary', type: 'button', text: 'Apply and restart', onclick: apply })), statusLine('launch-status'),
        el('div', { class: 'muted', text: 'Names are 1 to 32 of a-z 0-9 _ (not ticket or policy); at most 16; values at most 512 characters.' })),
      group('Application', el('div', { class: 'mono', id: 'ids' })),
    ];
  });

  addPanel('caps', 'Capabilities', function () {
    var box = el('div', { class: 'grid2', id: 'cap-grid' });
    var featureBox = el('div', { class: 'grid2', id: 'feature-grid' });
    function setAll(value) {
      var values = {};
      state.capability_names.forEach(function (name) { values[name] = value; });
      command({ command: 'capabilities', values: values });
    }
    return [
      group('Capabilities', box, el('div', { class: 'row' }, el('button', { type: 'button', text: 'Grant all', onclick: function () { setAll(true); } }), el('button', { type: 'button', text: 'Revoke all', onclick: function () { setAll(false); } })),
        el('div', { class: 'muted', text: 'A change sends the context again with the same binding; nothing restarts. Use Restart activation for a new generation.' })),
      group('Advertised features', featureBox, el('div', { class: 'muted', text: 'A kind whose feature is not advertised is answered not_supported.' })),
    ];
  });

  addPanel('page', 'Page', function () {
    var enabled = control('timer-enabled', el('input', { type: 'checkbox', id: 'timer-enabled' }));
    var maxMs = control('timer-max', el('input', { type: 'number', id: 'timer-max', min: 1000 }));
    var loop = control('loop', el('input', { type: 'checkbox', id: 'loop' }));
    function applyTimer() { command({ command: 'timer', enabled: enabled.checked, maxMs: Number(maxMs.value) }, 'timer-status'); }
    loop.addEventListener('change', function () { command({ command: 'loop', value: loop.checked }); });
    return [
      group('Page timer', el('div', { class: 'row' }, el('label', {}, enabled, 'Run the timer'), field('max_ms', maxMs), el('button', { type: 'button', text: 'Apply', onclick: applyTimer })), statusLine('timer-status'),
        el('div', { class: 'mono', id: 'timing' }),
        el('div', { class: 'row' }, el('label', {}, loop, 'Start the page again when it ends'))),
      group('Playback', el('div', { class: 'row' },
        el('button', { type: 'button', id: 'btn-pause', text: 'Pause', onclick: function () { command({ command: 'pause', paused: !state.host.held.includes('paused') }); } }),
        el('button', { type: 'button', id: 'btn-dark', text: 'Darken display', onclick: function () { command({ command: 'display', dark: !state.host.display_held_dark }); } }),
        el('button', { type: 'button', text: 'Fire leaving', onclick: function () { command({ command: 'leaving' }); } })),
        el('div', { class: 'muted', text: 'Pause and a dark display are the two causes of visibility.changed; the page is visible again when both have ended. Leaving is posted once.' }),
        el('div', { class: 'mono', id: 'playback' })),
    ];
  });

  function fireRow(title, inputs, build, statusId, hint) {
    var button = el('button', { type: 'button', text: 'Fire' });
    button.addEventListener('click', function () { fire(build(), statusId); });
    return group(title, el('div', { class: 'row' }, inputs, button), statusLine(statusId), hint ? el('div', { class: 'muted', text: hint }) : null);
  }

  addPanel('events', 'Device events', function () {
    var keyName = el('select', {}, el('option', { value: 'volume_up', text: 'volume_up' }), el('option', { value: 'volume_down', text: 'volume_down' }));
    var keyAction = el('select', {}, el('option', { value: 'down', text: 'down' }), el('option', { value: 'up', text: 'up' }));
    var keyRepeat = el('input', { type: 'checkbox' });
    var lux = el('input', { type: 'number', value: '120', step: 'any' });
    var online = el('select', {}, el('option', { value: 'true', text: 'online' }), el('option', { value: 'false', text: 'offline' }));
    var displayOn = el('select', {}, el('option', { value: 'true', text: 'on' }), el('option', { value: 'false', text: 'off' }));
    var brightness = el('input', { type: 'number', value: '0.5', min: 0, max: 1, step: '0.05' });
    var scanKind = el('select', {},
      el('option', { value: 'wedge', text: 'Keyboard-wedge scanner' }), el('option', { value: 'nfc:uid', text: 'NFC uid' }), el('option', { value: 'nfc:ndef_text', text: 'NFC text' }),
      el('option', { value: 'nfc:ndef_uri', text: 'NFC uri' }), el('option', { value: 'camera:qr', text: 'Camera qr' }), el('option', { value: 'camera:ean13', text: 'Camera ean13' }), el('option', { value: 'camera:code128', text: 'Camera code128' }));
    var scanData = el('input', { type: 'text', value: '4006381333931' });
    var people = el('input', { type: 'number', value: '2', min: 0, max: 1000 });
    var sound = el('input', { type: 'number', value: '-42', min: -120, max: 0, step: 'any' });
    return [
      fireRow('Presence', [], function () { return { device: 'presence' }; }, 'ev-presence', 'At most one per second.'),
      fireRow('Volume key', [keyName, keyAction, el('label', {}, keyRepeat, 'repeat')], function () { return { device: 'key', key: keyName.value, action: keyAction.value, repeat: keyRepeat.checked }; }, 'ev-key', 'A watched key is consumed by the Player.'),
      fireRow('Ambient light (lux)', [lux], function () { return { device: 'light', lux: Number(lux.value) }; }, 'ev-light', 'The first reading posts; later ones need a 10% change or a crossing of 1 lux, and 1 second.'),
      fireRow('Network', [online], function () { return { device: 'network', online: online.value === 'true' }; }, 'ev-network'),
      fireRow('Display (effective state)', [displayOn, brightness], function () { return { device: 'display', on: displayOn.value === 'true', brightness: Number(brightness.value) }; }, 'ev-display'),
      fireRow('Scan', [scanKind, scanData], function () {
        var parts = scanKind.value.split(':');
        if (parts[0] === 'wedge') return { device: 'typing', text: scanData.value, gapMs: 20, enter: true, field: false };
        return { device: 'scan', source: parts[0], format: parts[1], data: scanData.value };
      }, 'ev-scan', 'A camera read needs device.scanner.start. A wedge scan is 4 or more keys, 50 ms apart at most, ending in Enter.'),
      fireRow('People in view', [people], function () { return { device: 'people', count: Number(people.value) }; }, 'ev-people', 'The first reading posts, then changes, at most one per second.'),
      fireRow('Sound level (dBFS)', [sound], function () { return { device: 'sound', dbfs: Number(sound.value) }; }, 'ev-sound', 'At most one per second.'),
    ];
  });

  addPanel('hardware', 'Hardware', function () {
    return [
      group('Device', el('div', { class: 'row' },
        el('label', {}, control('hw-network', el('input', { type: 'checkbox', id: 'hw-network' })), 'Network online'),
        el('label', {}, control('hw-camera', el('input', { type: 'checkbox', id: 'hw-camera' })), 'Camera'),
        el('label', {}, control('hw-ble', el('input', { type: 'checkbox', id: 'hw-ble' })), 'Bluetooth adapter'),
        el('label', {}, control('hw-gpio', el('input', { type: 'checkbox', id: 'hw-gpio' })), 'GPIO chip')), el('div', { class: 'mono', id: 'scanner' })),
      group('Serial ports', el('div', { class: 'list', id: 'serial' }), statusLine('serial-status')),
      group('GPIO lines', el('div', { class: 'list', id: 'gpio' }), statusLine('gpio-status'),
        el('div', { class: 'muted', text: 'Click a level to drive the line from outside (a button pressed). A floating line has nothing connected: it reads its pull (up is high, down is low) and its own level with none. The application hears a line it watches.' }),
        el('div', { class: 'list', id: 'gpio-released' })),
      group('HDMI input', el('div', { class: 'mono', id: 'hdmi' }), el('div', { class: 'muted', text: 'While device.hdmi_input is granted the application frame may use the camera and microphone, so hdmiInput.open() gets this browser capture device. Switching it loads the frame again.' })),
      group('Bluetooth LE', el('div', { class: 'list', id: 'ble' }), statusLine('ble-status')),
      group('Printers', el('div', { class: 'list', id: 'printers' }), el('div', { class: 'list', id: 'jobs' })),
    ];
  });

  addPanel('ir-udp', 'IR and UDP', function () {
    var irCode = el('input', { type: 'text', value: '0x20DF10', 'aria-label': 'NEC code' });
    var irRepeat = el('input', { type: 'checkbox' });
    var irEmitter = control('hw-ir-emitter', el('input', { type: 'checkbox', id: 'hw-ir-emitter' }));
    var irReceiver = control('hw-ir-receiver', el('input', { type: 'checkbox', id: 'hw-ir-receiver' }));
    var udpSocket = control('udp-socket', el('select', { id: 'udp-socket', 'aria-label': 'Socket' }));
    var udpHost = el('input', { type: 'text', value: '127.0.0.1', size: 12, 'aria-label': 'Sender address' });
    var udpPort = el('input', { type: 'number', value: '40000', min: 1, max: 65535 });
    var udpData = el('input', { type: 'text', value: 'hello', 'aria-label': 'Datagram' });
    var udpHex = el('input', { type: 'checkbox' });
    function injectUdp() {
      var body = { command: 'udp-inject', socket: udpSocket.value || undefined, host: udpHost.value, port: Number(udpPort.value) };
      if (udpHex.checked) body.hex = udpData.value; else body.text = udpData.value;
      command(body, 'udp-status');
    }
    return [
      group('Infrared receiver', el('div', { class: 'row' }, field('NEC code', irCode), el('label', {}, irRepeat, 'repeat frame'), el('button', { type: 'button', text: 'Receive', onclick: function () {
        var code = Number(irCode.value);
        fire({ device: 'ir', code: code, repeat: irRepeat.checked }, 'ir-status');
      } })), statusLine('ir-status'),
        el('div', { class: 'muted', text: 'A received code reaches an application that watches ir. The code is 0 to 0xFFFFFF: the command in bits 0 to 7 and the address in bits 8 to 23. A repeat frame is the auto-repeat of a held button. A send of repeat n hands the emitter n + 1 frames.' }),
        el('div', { class: 'row' }, el('label', {}, irEmitter, 'Infrared emitter (send)'), el('label', {}, irReceiver, 'Infrared receiver (receive)'))),
      group('Codes the application sent', el('div', { class: 'list', id: 'ir-sent' })),
      group('UDP sockets', el('div', { class: 'mono', id: 'udp-where' }), el('div', { class: 'list', id: 'udp-sockets' })),
      group('Send a datagram to a socket', el('div', { class: 'row' }, udpSocket), el('div', { class: 'row' }, field('From', udpHost), udpPort),
        el('div', { class: 'row' }, udpData, el('label', {}, udpHex, 'hex'), el('button', { type: 'button', text: 'Send', onclick: injectUdp }),
          el('button', { type: 'button', text: 'Close socket (network fault)', title: 'The operating system closes the socket: the application hears closed with reason error', onclick: function () {
            if (udpSocket.value) fire({ device: 'udp', socket: udpSocket.value, closed: true }, 'udp-status');
          } })), statusLine('udp-status')),
      group('Datagrams', el('div', { class: 'list', id: 'udp-log' }), el('div', { class: 'muted', text: 'A datagram the application sends to a loopback address reaches the socket bound there; one sent anywhere else is recorded here and never transmitted.' })),
    ];
  });

  addPanel('kv', 'Stored values', function () {
    return [group('K/V', el('div', { class: 'mono', id: 'kv-where' }), el('div', { id: 'kv-table' }), el('button', { type: 'button', text: 'Refresh', onclick: function () { loadKv(); } }))];
  });

  addPanel('log', 'Log', function () {
    var debug = el('input', { type: 'checkbox', id: 'show-debug' });
    debug.addEventListener('change', function () { showDebug = debug.checked; renderLog(); });
    return [group('Events', el('div', { class: 'row' }, el('label', {}, debug, 'Show debug'), el('button', { type: 'button', class: 'small', text: 'Clear', onclick: function () { command({ command: 'clear-log' }); logEntries = []; renderLog(); } })), el('div', { class: 'log', id: 'log' }))];
  });

  var activeTab = 'launch';

  function buildPanels() {
    var tabs = $('tabs');
    var panels = $('panels');
    panelDefs.forEach(function (def) {
      var tab = el('button', { type: 'button', role: 'tab', 'aria-selected': def.id === activeTab ? 'true' : 'false', text: def.title, onclick: function () { selectTab(def.id); } });
      tab.dataset.tab = def.id;
      tabs.appendChild(tab);
      var panel = el('section', { class: 'panel' + (def.id === activeTab ? ' on' : ''), id: 'panel-' + def.id });
      def.build().forEach(function (part) { panel.appendChild(part); });
      panels.appendChild(panel);
    });
  }

  function selectTab(id) {
    activeTab = id;
    Array.prototype.forEach.call($('tabs').children, function (tab) { tab.setAttribute('aria-selected', tab.dataset.tab === id ? 'true' : 'false'); });
    panelDefs.forEach(function (def) { $('panel-' + def.id).className = 'panel' + (def.id === id ? ' on' : ''); });
    if (id === 'kv') loadKv();
    if (id === 'log') renderLog();
  }

  function renderCapabilities() {
    var grid = $('cap-grid');
    if (!grid.firstChild) {
      state.capability_names.forEach(function (name) {
        var box = el('input', { type: 'checkbox', id: 'cap-' + name });
        box.addEventListener('change', function () { command({ command: 'capability', name: name, value: box.checked }); });
        grid.appendChild(el('label', { class: 'row' }, box, el('span', { class: 'mono', text: name })));
      });
      state.feature_names.forEach(function (name) {
        var box = el('input', { type: 'checkbox', id: 'feat-' + name });
        box.addEventListener('change', function () { command({ command: 'feature', name: name, value: box.checked }); });
        $('feature-grid').appendChild(el('label', { class: 'row' }, box, el('span', { class: 'mono', text: name })));
      });
    }
    state.capability_names.forEach(function (name) { $('cap-' + name).checked = state.host.capabilities[name] === true; });
    var advertised = state.host.features || [];
    state.feature_names.forEach(function (name) { $('feat-' + name).checked = advertised.indexOf(name) >= 0; });
  }

  function seconds(ms) { return ms === null ? 'none' : (ms / 1000).toFixed(1) + ' s'; }

  function renderStatic() {
    setIfIdle(controls['width'], state.viewport.width);
    setIfIdle(controls['height'], state.viewport.height);
    controls['preset'].value = state.preset;
    setIfIdle(controls['screen-name'], state.screen.name);
    setIfIdle(controls['screen-zone'], state.screen.timezone);
    if (document.activeElement !== controls['params']) controls['params'].value = Object.keys(state.params).map(function (k) { return k + '=' + state.params[k]; }).join('\n');
    $('ids').textContent = 'application_id ' + state.application_id + '\nrelease_id     ' + state.release_id + '\ndirectory      ' + state.directory;
    $('ids').style.whiteSpace = 'pre-wrap';
    controls['timer-enabled'].checked = state.timer.enabled;
    setIfIdle(controls['timer-max'], state.timer.maxMs);
    controls['loop'].checked = state.loop;
    var host = state.host;
    $('timing').textContent = 'elapsed ' + seconds(host.page.elapsed_ms) + '   remaining ' + seconds(host.page.remaining_ms) + '   ' + (host.page.paused ? 'held' : 'running');
    $('playback').textContent = 'visibility.watch ' + (host.visibility_watching ? 'on' : 'off') + '   causes: ' + (host.held.length ? host.held.join(', ') : 'none') + '\ndisplay ' + (host.display.on ? 'on' : 'off') + (host.display.brightness === null ? '' : ', brightness ' + host.display.brightness) + (host.display_held_dark ? ' (held dark)' : '') + '\nwatching: ' + (host.watching.length ? host.watching.join(', ') : 'nothing') + '\nready ' + host.ready + '   advanced ' + host.advanced;
    $('playback').style.whiteSpace = 'pre-wrap';
    $('btn-pause').textContent = host.held.indexOf('paused') >= 0 ? 'Resume' : 'Pause';
    $('btn-dark').textContent = host.display_held_dark ? 'Light display' : 'Darken display';
    var hardware = host.hardware;
    wire('hw-network', host.network.online, function (v) { command({ command: 'hardware', change: 'network', value: v }); });
    wire('hw-camera', hardware.camera.available, function (v) { command({ command: 'hardware', change: 'camera.available', value: v }); });
    wire('hw-ble', hardware.ble.adapter, function (v) { command({ command: 'hardware', change: 'ble.adapter', value: v }); });
    wire('hw-gpio', hardware.gpio.chip, function (v) { command({ command: 'hardware', change: 'gpio.chip', value: v }); });
    wire('hw-ir-emitter', hardware.ir.emitter, function (v) { command({ command: 'hardware', change: 'ir.emitter', value: v }); });
    wire('hw-ir-receiver', hardware.ir.receiver, function (v) { command({ command: 'hardware', change: 'ir.receiver', value: v }); });
    $('hdmi').textContent = 'device.hdmi_input ' + (host.capabilities['device.hdmi_input'] ? 'granted: the frame allows camera and microphone' : 'not granted: the frame has no camera or microphone') + '\nframe allow: ' + state.frame_allow;
    $('hdmi').style.whiteSpace = 'pre-wrap';
    $('scanner').textContent = 'scanner ' + (host.frame.scanning ? 'running' : 'stopped') + '   camera reads: ' + hardware.camera.formats.join(', ');
  }

  var wired = {};
  function wire(id, value, onChange) {
    var box = $(id);
    box.checked = value;
    if (!wired[id]) { wired[id] = true; box.addEventListener('change', function () { onChange(box.checked); }); }
  }

  function hexOf(base64) {
    try { return Array.prototype.map.call(atob(base64), function (c) { return ('0' + c.charCodeAt(0).toString(16)).slice(-2); }).join(''); } catch (e) { return ''; }
  }

  function renderHardware() {
    var host = state.host;
    var hardware = host.hardware;
    var serial = $('serial');
    serial.textContent = '';
    hardware.serial.ports.forEach(function (port) {
      var open = host.frame.ports.filter(function (item) { return item.port === port.id; })[0];
      var text = el('input', { type: 'text', placeholder: 'text to send', 'aria-label': 'Text to send to ' + port.id });
      var echo = el('input', { type: 'checkbox' });
      echo.checked = port.echo === true;
      echo.addEventListener('change', function () { command({ command: 'hardware', change: 'serial.echo', id: port.id, value: echo.checked }); });
      var busy = el('input', { type: 'checkbox' });
      busy.checked = port.busy === true;
      busy.addEventListener('change', function () { command({ command: 'hardware', change: 'serial.busy', id: port.id, value: busy.checked }); });
      var item = el('div', { class: 'item' },
        el('div', { class: 'head' }, el('span', { class: 'mono', text: port.id + '  ' + port.name }), el('span', { class: 'muted', text: open ? 'open ' + open.handle : 'closed' })),
        el('div', { class: 'row' }, el('label', {}, echo, 'echo writes'), el('label', {}, busy, 'held by another process')));
      if (open) {
        item.appendChild(el('div', { class: 'row' }, text, el('button', { type: 'button', class: 'small', text: 'Send', onclick: function () { command({ command: 'serial-send', handle: open.handle, text: text.value }, 'serial-status'); } }),
          el('button', { type: 'button', class: 'small', text: 'Unplug', onclick: function () { fire({ device: 'serial', handle: open.handle, closed: true, reason: 'unplugged' }, 'serial-status'); } }),
          el('button', { type: 'button', class: 'small', text: 'Fail', onclick: function () { fire({ device: 'serial', handle: open.handle, closed: true, reason: 'error' }, 'serial-status'); } })));
      }
      serial.appendChild(item);
    });
    var gpio = $('gpio');
    gpio.textContent = '';
    hardware.gpio.pins.forEach(function (pin) {
      var listened = host.frame.pins.indexOf(pin.pin) >= 0;
      var key = String(pin.pin);
      var level = host.frame.levels[key] === true;
      var pull = host.frame.pull[key] || 'none';
      var idle = host.frame.idle[key];
      var levelButton = el('button', { type: 'button', class: 'small', text: level ? 'high' : 'low', onclick: function () { fire({ device: 'gpio', pin: pin.pin, value: !level }, 'gpio-status'); } });
      var busy = el('input', { type: 'checkbox' });
      busy.checked = pin.busy === true;
      busy.addEventListener('change', function () { command({ command: 'hardware', change: 'pin.busy', id: key, value: busy.checked }); });
      var floating = el('input', { type: 'checkbox' });
      floating.checked = pin.floating === true;
      floating.addEventListener('change', function () { command({ command: 'hardware', change: 'pin.floating', id: key, value: floating.checked }); });
      var released = pin.floating === true && pin.driven !== undefined ? el('button', { type: 'button', class: 'small', text: 'Let go', title: 'Stop driving the line from outside: it floats to its pull again', onclick: function () { fire({ device: 'gpio', pin: pin.pin, value: null }, 'gpio-status'); } }) : null;
      var notes = [];
      if (listened) notes.push('application listens, pull ' + pull);
      if (idle !== undefined) notes.push('written: let go at ' + (idle ? 'high' : 'low'));
      gpio.appendChild(el('div', { class: 'item' },
        el('div', { class: 'head' }, el('span', { class: 'mono', text: 'line ' + pin.pin }), el('span', { class: 'row' }, levelButton, released), el('span', { class: 'muted', text: notes.join('; ') })),
        el('div', { class: 'row' }, el('label', {}, floating, 'nothing connected (floating)'), el('label', {}, busy, 'held by another process'))));
    });
    var letGo = $('gpio-released');
    letGo.textContent = '';
    host.frame.released.slice(-6).reverse().forEach(function (item) {
      letGo.appendChild(el('div', { class: 'item' }, el('span', { class: 'mono', text: 'line ' + item.pin + ' driven ' + (item.value ? 'high' : 'low') + ' and released: ' + (item.cause === 'leaving' ? 'the page left the glass' : item.cause === 'context' ? 'its context ended' : 'it was destroyed') })));
    });
    var ble = $('ble');
    ble.textContent = '';
    hardware.ble.peripherals.forEach(function (peripheral) {
      peripheral.services.forEach(function (service) {
        service.characteristics.forEach(function (item) {
          var subs = host.frame.subscriptions.filter(function (sub) { return sub.service === service.service && sub.characteristic === item.characteristic; });
          var hex = el('input', { type: 'text', value: hexOf(item.value_base64), 'aria-label': 'Notification bytes in hexadecimal' });
          ble.appendChild(el('div', { class: 'item' },
            el('div', { class: 'head' }, el('span', { class: 'mono', text: peripheral.name + '  ' + service.service + ' / ' + item.characteristic }), el('span', { class: 'muted', text: subs.length + ' subscription' + (subs.length === 1 ? '' : 's') })),
            el('div', { class: 'row' }, hex, el('button', { type: 'button', class: 'small', text: 'Notify', onclick: function () { command({ command: 'ble-notify', service: service.service, characteristic: item.characteristic, hex: hex.value }, 'ble-status'); } }))));
        });
      });
    });
    var printers = $('printers');
    printers.textContent = '';
    hardware.printers.forEach(function (printer) {
      var failing = el('input', { type: 'checkbox' });
      failing.checked = printer.failing === true;
      failing.addEventListener('change', function () { command({ command: 'hardware', change: 'printer.failing', id: printer.id, value: failing.checked }); });
      printers.appendChild(el('div', { class: 'item' }, el('div', { class: 'head' }, el('span', { class: 'mono', text: printer.id + '  ' + printer.name }), el('span', { class: 'muted', text: printer.formats.join(', ') + (printer.default ? ', default' : '') })), el('label', { class: 'row' }, failing, 'accepts jobs and fails them')));
    });
    var jobs = $('jobs');
    jobs.textContent = '';
    host.frame.printed.slice().reverse().forEach(function (job) {
      jobs.appendChild(el('div', { class: 'item' }, el('div', { class: 'head' }, el('span', { class: 'mono', text: job.job }), el('span', { class: job.failed ? 'pill bad' : 'pill ok', text: (job.failed ? 'failed' : 'printed') + ' on ' + job.printer + ', ' + job.bytes + ' bytes, ' + job.format })), el('pre', { class: 'mono', text: job.preview })));
    });
  }

  function hex(value) { var text = Number(value).toString(16).toUpperCase(); while (text.length < 6) text = '0' + text; return '0x' + text; }

  function renderIrUdp() {
    var frameState = state.host.frame;
    var sent = $('ir-sent');
    sent.textContent = '';
    frameState.ir_sent.slice().reverse().forEach(function (item) {
      sent.appendChild(el('div', { class: 'item' }, el('span', { class: 'mono', text: item.encoding + ' ' + hex(item.code) + (item.repeat ? ', sent ' + (item.repeat + 1) + ' times' : '') + '  wire ' + item.frames[0].map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('') })));
    });
    if (!frameState.ir_sent.length) sent.appendChild(el('div', { class: 'muted', text: 'None yet.' }));
    $('udp-where').textContent = frameState.udp_transport === 'loopback' ? 'Sockets bind on 127.0.0.1 only: a tool on this machine can send them datagrams.' : 'Sockets are simulated: nothing is bound.';
    var select = $('udp-socket');
    var chosen = select.value;
    select.textContent = '';
    frameState.sockets.forEach(function (socket) { select.appendChild(el('option', { value: socket.handle, text: socket.handle + (socket.port ? '  port ' + socket.port : '  send only') })); });
    if (chosen) select.value = chosen;
    var sockets = $('udp-sockets');
    sockets.textContent = '';
    frameState.sockets.forEach(function (socket) {
      sockets.appendChild(el('div', { class: 'item' }, el('span', { class: 'mono', text: socket.handle + '  ' + (socket.port ? 'port ' + socket.port : 'send only') + (socket.broadcast ? ', broadcast' : '') + (socket.multicast ? ', multicast ' + socket.multicast : '') })));
    });
    if (!frameState.sockets.length) sockets.appendChild(el('div', { class: 'muted', text: 'The application holds no socket.' }));
    var log = $('udp-log');
    log.textContent = '';
    frameState.datagrams.slice().reverse().forEach(function (item) {
      var where = item.direction === 'sent' ? 'to ' : 'from ';
      var how = item.direction === 'sent' ? (item.delivered ? ', delivered on loopback' : ', recorded only') : '';
      log.appendChild(el('div', { class: 'item' }, el('div', { class: 'head' }, el('span', { class: 'mono', text: item.direction + ' ' + where + item.host + ':' + item.port + how }), el('span', { class: 'muted', text: item.bytes + ' bytes' })), el('pre', { class: 'mono', text: item.text + '\n' + item.hex })));
    });
  }

  function loadKv() {
    fetch('/_dev/kv').then(function (response) { return response.json(); }).then(function (kv) {
      $('kv-where').textContent = kv.mode + (kv.location ? '  ' + kv.location : '');
      var table = $('kv-table');
      table.textContent = '';
      if (kv.problem) { table.appendChild(el('div', { class: 'status bad', text: kv.problem })); return; }
      var body = el('tbody', {});
      kv.items.forEach(function (item) {
        body.appendChild(el('tr', {}, el('td', { class: 'mono', text: item.key }), el('td', { text: String(item.revision) }), el('td', { text: item.content_type + ', ' + item.bytes + ' bytes' }), el('td', { class: 'mono', text: item.preview })));
      });
      if (!kv.items.length) body.appendChild(el('tr', {}, el('td', { colspan: 4, class: 'muted', text: 'No keys.' })));
      table.appendChild(el('table', { class: 'kv' }, el('thead', {}, el('tr', {}, el('th', { text: 'Key' }), el('th', { text: 'Rev' }), el('th', { text: 'Type' }), el('th', { text: 'Value' }))), body));
    }, function () {});
  }

  function renderLog() {
    var box = $('log');
    if (!box) return;
    box.textContent = '';
    logEntries.slice(-300).forEach(function (entry) {
      if (entry.level === 'debug' && !showDebug) return;
      var time = entry.at ? entry.at.slice(11, 19) : '';
      var text = (entry.code ? entry.code + '  ' : '') + (entry.message || '');
      var row = el('div', { class: 'entry ' + (entry.level || '') }, el('span', { class: 't', text: time }), el('span', { class: 'k', text: entry.type }), el('div', {}, text ? el('div', { text: text }) : null,
        entry.detail && Object.keys(entry.detail).length ? el('details', {}, el('summary', { text: 'detail' }), el('pre', { text: JSON.stringify(entry.detail, null, 2) })) : null));
      box.appendChild(row);
    });
    box.scrollTop = box.scrollHeight;
    var panel = $('panel-log');
    if (panel && panel.className.indexOf('on') >= 0) $('panels').scrollTop = $('panels').scrollHeight;
    if (entryNeedsKv()) { if (activeTab === 'kv') loadKv(); }
  }

  function entryNeedsKv() {
    var last = logEntries[logEntries.length - 1];
    return last && last.type === 'kv.changed';
  }

  var capabilitiesBuilt = false;

  function render() {
    renderTop();
    renderBanners();
    if (!capabilitiesBuilt) { capabilitiesBuilt = true; }
    renderCapabilities();
    renderStatic();
    renderHardware();
    renderIrUdp();
    layoutFrame();
    renderLog();
  }

  $('btn-restart').addEventListener('click', function () { command({ command: 'restart' }); });
  $('btn-reload').addEventListener('click', function () { command({ command: 'reload' }); });
  buildPanels();
  connect();
}());
`;

export function harnessHtml(): string {
  return HTML;
}

export function harnessCss(): string {
  return CSS;
}

export function harnessScript(): string {
  return SCRIPT;
}
