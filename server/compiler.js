const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

function parseInstructions(source, mode = 'smart') {
  const lines = source.split(/\r?\n/);
  const entities = {};
  const rules = [];
  const diagnostics = [];

  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return;

    const sepMatch = trimmed.match(/^([^=:->]+?)\s*(?:=|:|->)\s*(.+)$/);
    if (sepMatch) {
      const key = sepMatch[1].trim();
      const value = sepMatch[2].trim().replace(/[;,]$/, '');
      if (!entities[key]) entities[key] = { traits: [], lines: [] };
      if (!entities[key].traits.includes(value)) entities[key].traits.push(value);
      entities[key].lines.push(lineNum);
    } else {
      rules.push({ line: lineNum, raw: trimmed });
    }
  });

  return { entities, rules, diagnostics, mode };
}

const KNOWN_CONSONANT_WORDS = new Set([
  'fps', '3d', '2d', 'html', 'css', 'js', 'svg', 'npc', 'npcs', 'hud', 'ui', 'vx', 'vy', 'vz',
  'dx', 'dy', 'dz', 'rgb', 'rgba', 'hsl', 'btn', 'txt', 'xp', 'hp', 'mp', 'kb', 'mb', 'gb',
  'str', 'int', 'ptr', 'sys', 'cmd', 'src', 'dst', 'tmp', 'rng', 'ai', 'vr', 'ar', 'fx', 'sfx',
  'bgm', 'px', 'ms', 'wasd', 'ctrl', 'shift', 'esc', 'glsl', 'webgl', 'http', 'https', 'url', 'www',
  'ttf', 'png', 'jpg', 'mp3', 'wav', 'json', 'xml', 'py', 'ts', 'tsx', 'jsx', 'cpp', 'csharp'
]);

function looksLikeGibberishToken(word) {
  const w = word.toLowerCase();
  if (!w || w.length <= 2 || KNOWN_CONSONANT_WORDS.has(w) || /^\d+$/.test(w)) return false;
  if (/^(asdf|qwer|zxcv|hjkl|fdsa|poiuy|lkjh|mnbv|blah|bruh|lol|lmao|rofl|idk|whatever|gibberish|nothing|none|null|undefined|foo|bar|baz|qwerty|abcde|xyz)+$/i.test(w)) {
    return true;
  }
  if (/(.)\1{3,}/.test(w)) return true; // e.g. aaaa, zzzz
  // 5+ consecutive consonants in an alphabetic word is almost always keyboard smash
  if (/^[a-z]+$/.test(w) && /[bcdfghjklmnpqrstvwxyz]{5,}/.test(w)) return true;
  // Long alphabetic word (6+ chars) with zero vowels
  if (/^[a-z]{6,}$/.test(w) && !/[aeiouy]/.test(w)) return true;
  return false;
}

function validateCodeSyntax(source, mode = 'smart') {
  const errors = [];
  const lines = (source || '').split(/\r?\n/);
  const codeLines = [];

  lines.forEach((raw, idx) => {
    const lineNum = idx + 1;
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return;
    codeLines.push({ lineNum, t });

    const eqMatch = t.match(/^([a-zA-Z_][\w\s.]*?)\s*(=|:|->|\+=|-=|\*=|\/=)\s*(.+)$/);
    const isControlBlock = /^(if|elif|else|when|whenever|while|for|every|repeat|def|function|class|on|try|except|finally)\b.*(:|\{)?$/i.test(t);
    const isKeywordStmt = /^(import|from|use|include|require|print|return|break|continue|pass|end|done|spawn|delete|remove|\})\b/i.test(t);
    const isFuncCall = /^[a-zA-Z_][\w.]*\s*\(.*\)$/.test(t);

    if (!eqMatch && !isControlBlock && !isKeywordStmt && !isFuncCall) {
      errors.push({
        severity: 'error',
        line: lineNum,
        code: 'SYNTAX-ERR',
        message: `SyntaxError on line ${lineNum}: Invalid statement "${t}". You cannot write plain English sentences — use code syntax like: game = 3d, graphics = good, guns = faster, or if/when blocks.`
      });
      return;
    }

    // Check for gibberish / keyboard smash / bullshit tokens (skip inside quoted strings)
    const strippedQuotes = t.replace(/"[^"]*"|'[^']*'/g, '');
    const tokens = strippedQuotes.match(/[a-zA-Z0-9_]+/g) || [];
    for (const tok of tokens) {
      if (looksLikeGibberishToken(tok)) {
        errors.push({
          severity: 'error',
          line: lineNum,
          code: 'GIBBERISH-ERR',
          message: `CompilerError on line ${lineNum}: "${tok}" looks like nonsense/gibberish. Write real code properties and values.`
        });
        return;
      }
    }

    if (eqMatch) {
      const k = eqMatch[1].trim().toLowerCase();
      const v = eqMatch[3].trim().toLowerCase();
      if (/^(idk|whatever|something|stuff|things|nothing|none|null|asdf|blah|test)$/i.test(v)) {
        errors.push({
          severity: 'error',
          line: lineNum,
          code: 'VAGUE-VAL',
          message: `CompilerError on line ${lineNum}: "${k} = ${eqMatch[3].trim()}" is a placeholder/nonsense value. Specify what "${k}" actually should be.`
        });
      }
    }
  });

  if (!codeLines.length) {
    errors.push({
      severity: 'error',
      line: 1,
      code: 'EMPTY-FILE',
      message: 'SyntaxError: File has no executable statements. Write code like: game = 3d, player = fast, controls = wasd'
    });
    return errors;
  }

  // Reject single-line orphaned modifiers like just "enemy = human" or "speed = fast" with no core program/entity
  if (errors.length === 0 && codeLines.length === 1) {
    const only = codeLines[0].t.toLowerCase();
    const hasCoreSubject =
      /^(print|import|from|def|class|if|when|every)\b/.test(only) ||
      /^(game|app|simulation|sim|calculator|calc|program|tool|dashboard|world|scene|me|player|car|hero|screen|window)\b/.test(only) ||
      /^[a-zA-Z_]\w*\s*\(.*\)$/.test(only);
    if (!hasCoreSubject) {
      errors.push({
        severity: 'error',
        line: codeLines[0].lineNum,
        code: 'INCOMPLETE-PROGRAM',
        message: `IncompleteCodeError: "${codeLines[0].t}" alone is not enough to build an app. Define what you're building first (e.g. "game = 3d", "player = fast", "simulation = gravity", or "print ...").`
      });
    }
  }

  return errors;
}

function validateHardMode(source, ir) {
  const errors = [];
  const lines = source.split(/\r?\n/);

  // Hard Mode no longer forces boilerplate like "screen =" or "start =";
  // instead, if you don't write start_screen, there simply won't be one.
  // It only ensures every line is structured and non-vague.
  lines.forEach((raw, idx) => {
    const lineNum = idx + 1;
    const t = raw.trim();
    if (!t || t.startsWith('//') || t.startsWith('#')) return;

    const eq = t.match(/^([^=:->]+?)\s*(?:=|:|->)\s*(.*)$/);
    if (eq) {
      const v = eq[2].trim().toLowerCase();
      if (!v) {
        errors.push({
          severity: 'error',
          line: lineNum,
          code: 'HARD-EMPTY-VAL',
          message: `Hard Mode Error: "${eq[1].trim()}" has no value assigned.`
        });
      }
    }
  });

  return errors;
}

function detectTarget(ir, source, requestedTarget = 'auto') {
  if (requestedTarget && requestedTarget !== 'auto') return requestedTarget;
  const lower = source.toLowerCase();
  if (/\b(python|\.py|pip|pandas|tkinter|pygame)\b/.test(lower)) return 'python';
  if (/\b(node|express|cli|terminal script)\b/.test(lower)) return 'node';
  return 'web-app';
}

function getCodexCatalog() {
  const codexHome = path.join(os.homedir(), '.codex');
  const cachePath = path.join(codexHome, 'models_cache.json');
  const authPath = path.join(codexHome, 'auth.json');
  const configPath = path.join(codexHome, 'config.toml');

  let defaultModel = 'gpt-6-sol';
  if (fs.existsSync(configPath)) {
    const cfg = fs.readFileSync(configPath, 'utf-8');
    const m = cfg.match(/^\s*model\s*=\s*"([^"]+)"/m);
    if (m && m[1] !== 'gpt-6.1-sol') defaultModel = m[1];
  }

  let models = [];
  if (fs.existsSync(cachePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      models = (data.models || [])
        .filter((m) => m.slug && m.slug !== 'codex-auto-review')
        .map((m) => ({
          value: m.slug,
          label: `${m.display_name || m.slug}${m.description ? ' — ' + m.description : ''}`,
          shortLabel: m.display_name || m.slug
        }));
    } catch {}
  }

  if (models.length === 0) {
    models = [
      { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol — Latest workhorse model', shortLabel: 'GPT-6.1-Sol' },
      { value: 'gpt-6-astra', label: 'GPT-6-Astra — Frontier intelligence', shortLabel: 'GPT-6-Astra' },
      { value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', shortLabel: 'GPT-6.1 Terra' },
      { value: 'gpt-reserve', label: 'GPT-Reserve — Fast agentic coding', shortLabel: 'GPT-Reserve' },
      { value: 'gpt-6-luna', label: 'GPT-6-Luna — Fast and affordable', shortLabel: 'GPT-6-Luna' }
    ];
  }

  let loggedIn = fs.existsSync(authPath) && fs.statSync(authPath).size > 10;
  if (!loggedIn) {
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync(resolveCodexBinary(), ['login', 'status'], { timeout: 1500, encoding: 'utf-8' });
      if (r.status === 0 && !/not logged in/i.test((r.stdout || '') + (r.stderr || ''))) {
        loggedIn = true;
      }
    } catch {}
  }

  return {
    loggedIn,
    defaultModel,
    models
  };
}

function resolveCodexBinary() {
  if (process.platform === 'win32') {
    const candidate = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (fs.existsSync(candidate)) return candidate;
    return 'codex.exe';
  }
  const macLinuxCandidates = [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
    path.join(os.homedir(), '.local', 'bin', 'codex')
  ];
  for (const c of macLinuxCandidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'codex';
}

const DEFAULT_GROK_MODEL = 'grok-4.7';

function grokHomeDir() {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
}

function resolveGrokBinary() {
  const name = process.platform === 'win32' ? 'grok.exe' : 'grok';
  const homeBin = path.join(grokHomeDir(), 'bin', name);
  if (fs.existsSync(homeBin)) return homeBin;
  return name;
}

function grokCliInstalled() {
  const bin = resolveGrokBinary();
  if (path.isAbsolute(bin)) return fs.existsSync(bin);
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => fs.existsSync(path.join(dir, bin)));
}

function grokCliEnv() {
  const env = { ...process.env };
  delete env.XAI_API_KEY;
  delete env.GROK_API_KEY;
  return env;
}

function grokModel(provider) {
  const model = (provider?.model || '').trim();
  if (model.startsWith('grok-')) return model;
  return DEFAULT_GROK_MODEL;
}

function getGrokAuthStatus() {
  const installed = grokCliInstalled();
  const authPath = path.join(grokHomeDir(), 'auth.json');
  if (!fs.existsSync(authPath)) {
    return { installed, loggedIn: false, email: '', name: '', updatedAt: 0 };
  }
  let updatedAt = 0;
  try {
    updatedAt = fs.statSync(authPath).mtimeMs || 0;
  } catch {}
  try {
    const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const entry = Object.values(data).find((value) => (
      value && typeof value === 'object' && (value.refresh_token || value.key || value.access_token)
    ));
    if (!entry) return { installed, loggedIn: false, email: '', name: '', updatedAt };
    const name = [entry.first_name, entry.last_name].filter((part) => typeof part === 'string' && part).join(' ');
    return {
      installed,
      loggedIn: true,
      email: typeof entry.email === 'string' ? entry.email : '',
      name,
      updatedAt
    };
  } catch {
    return { installed, loggedIn: false, email: '', name: '', updatedAt };
  }
}

function isGeminiApiProvider(provider) {
  if (!provider) return false;
  if (provider.type === 'gemini-api') return true;
  if (provider.type === 'openai-compatible') {
    const tok = (provider.token || '').trim();
    const ep = (provider.endpoint || '').toLowerCase();
    if (tok.startsWith('AIza') || ep.includes('googleapis.com')) return true;
  }
  return false;
}

async function testAIProvider(provider) {
  if (!provider) throw new Error('No AI provider selected.');

  if (provider.type === 'ollama') {
    const endpoint = (provider.endpoint || 'http://localhost:11434').replace(/\/$/, '');
    const res = await fetch(`${endpoint}/api/tags`);
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return { ok: true, message: `Ollama connected (${models.length} model(s): ${models.slice(0, 3).join(', ') || 'none'})` };
  }

  if (isGeminiApiProvider(provider)) {
    const token = (provider.token || '').trim();
    if (!token) throw new Error('Paste your Google Gemini API key (starts with AIza...) in the API Key field.');
    const model = provider.model && provider.model.startsWith('gemini') ? provider.model : 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Say ok' }] }],
        generationConfig: { maxOutputTokens: 8 }
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini API HTTP ${res.status}: ${errText.slice(0, 140)}`);
    }
    return { ok: true, message: `Google Gemini API connected • Active model: ${model}` };
  }

  if (provider.type === 'grok') {
    const status = getGrokAuthStatus();
    if (!status.installed) {
      throw new Error('Grok CLI is not installed. Install it with: curl -fsSL https://x.ai/cli/install.sh | bash');
    }
    if (!status.loggedIn) {
      throw new Error('Grok is not signed in. Click Sign in with Grok in Settings.');
    }
    return { ok: true, message: `Grok signed in with OAuth • ${grokModel(provider)}` };
  }

  if (provider.type === 'openai-compatible') {
    const endpoint = (provider.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '');
    const token = (provider.token || '').trim();
    if (!token && endpoint.includes('api.openai.com')) {
      throw new Error('Paste your API Key in the API Key field first.');
    }
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const model = provider.model && !provider.model.includes('-sol') && !provider.model.includes('-luna') ? provider.model : 'gpt-4o-mini';
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Say ok' }]
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 140)}`);
    }
    return { ok: true, message: `Connected to ${endpoint} (${model})` };
  }

  if (provider.type === 'cli') {
    const cli = (provider.cli || 'codex').trim();
    if (cli === 'codex') {
      const cat = getCodexCatalog();
      return {
        ok: cat.loggedIn,
        message: cat.loggedIn
          ? `ChatGPT Account connected via Codex • Active model: ${provider.model || cat.defaultModel}`
          : 'Codex installed, but not logged in yet. Click "Sign In / Switch Account".'
      };
    }
    if (cli === 'gemini') {
      const hasOAuth = fs.existsSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json'));
      return new Promise((resolve, reject) => {
        execFile('gemini', ['--version'], { shell: true, timeout: 6000 }, (err, stdout) => {
          if (err) return reject(new Error(`Gemini CLI not found: ${err.message}`));
          resolve({
            ok: true,
            message: hasOAuth
              ? `Google Account connected via Gemini CLI (v${(stdout || '').trim()}) • Active model: ${provider.model || 'gemini-2.5-flash'}`
              : `Gemini CLI v${(stdout || '').trim()} installed — click "Sign In / Switch Account" if prompted.`
          });
        });
      });
    }
    return new Promise((resolve, reject) => {
      execFile(cli, ['--version'], { shell: true, timeout: 5000 }, (err, stdout) => {
        if (err) return reject(new Error(`CLI "${cli}" not found: ${err.message}`));
        resolve({ ok: true, message: `CLI "${cli}" ready (${provider.model}): ${(stdout || 'ok').trim().slice(0, 80)}` });
      });
    });
  }

  throw new Error(`Unsupported provider type: ${provider.type}`);
}

function snapshotFiles(dir, base = '') {
  const map = {};
  if (!fs.existsSync(dir)) return map;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(map, snapshotFiles(path.join(dir, entry.name), rel));
    } else if (
      !entry.name.endsWith('.py') &&
      entry.name !== 'instructions.txt' &&
      entry.name !== 'intent.ir.json' &&
      entry.name !== '_direct_output.html'
    ) {
      const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
      if (content.includes('<span>Direct Code Output</span>')) continue;
      map[rel] = content;
    }
  }
  return map;
}

function snapshotPyFiles(dir, base = '') {
  const map = {};
  if (!fs.existsSync(dir)) return map;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(map, snapshotPyFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.py')) {
      map[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
    }
  }
  return map;
}

let activeBuildProc = null;

function killProcTree(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      proc.kill('SIGKILL');
    }
  } catch {}
}

function cancelActiveBuild() {
  if (activeBuildProc) {
    killProcTree(activeBuildProc);
    activeBuildProc = null;
  }
}

function runProcess({ bin, args, prompt, cwd, emit, useShell = false, timeoutMs = 300000, env }) {
  cancelActiveBuild();
  return new Promise((resolve, reject) => {
    emit('terminal', { stream: 'system', text: `$ ${path.basename(bin)} ${args.join(' ')}\r\n` });
    const proc = spawn(bin, args, { cwd, shell: useShell, windowsHide: true, env: env || process.env });
    activeBuildProc = proc;
    let stdout = '';
    let stderr = '';

    let timer = null;
    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        killProcTree(proc);
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    };
    resetTimer();

    proc.stdout.on('data', (chunk) => {
      resetTimer();
      const text = chunk.toString();
      stdout += text;
      emit('terminal', { stream: 'stdout', text });
    });

    proc.stderr.on('data', (chunk) => {
      resetTimer();
      const text = chunk.toString();
      stderr += text;
      emit('terminal', { stream: 'stderr', text });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (activeBuildProc === proc) activeBuildProc = null;
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (activeBuildProc === proc) activeBuildProc = null;
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(stderr.trim() || `Exited with code ${code}`));
      }
      resolve({ stdout, stderr, code });
    });

    if (prompt) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }
  });
}

function extractGrokStreamText(raw) {
  const parts = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === 'text' && typeof event.data === 'string') parts.push(event.data);
  }
  return parts.join('');
}

function runGrokHeadless({ bin, args, cwd, emit, env, timeoutMs = 180000 }) {
  cancelActiveBuild();
  return new Promise((resolve, reject) => {
    emit('terminal', { stream: 'system', text: `$ ${path.basename(bin)} ${args.join(' ')}\r\n` });
    const proc = spawn(bin, args, { cwd, windowsHide: true, env: env || process.env });
    activeBuildProc = proc;
    let stdout = '';
    let stderr = '';
    let pending = '';
    let thoughtNoted = false;
    let timer = null;

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        killProcTree(proc);
        reject(new Error(`Grok stopped sending output for ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    };
    resetTimer();

    const takeLines = (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (event.type === 'text' && typeof event.data === 'string') {
          emit('terminal', { stream: 'stdout', text: event.data });
        } else if (event.type === 'thought' && !thoughtNoted) {
          thoughtNoted = true;
          emit('terminal', { stream: 'system', text: '[grok] thinking...\r\n' });
        }
      }
    };

    proc.stdout.on('data', (chunk) => {
      resetTimer();
      stdout += chunk.toString();
      takeLines(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      resetTimer();
      const text = chunk.toString();
      stderr += text;
      emit('terminal', { stream: 'stderr', text });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (activeBuildProc === proc) activeBuildProc = null;
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (activeBuildProc === proc) activeBuildProc = null;
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(stderr.trim() || `Grok exited with code ${code}`));
      }
      resolve({ stdout, stderr, code, text: extractGrokStreamText(stdout) });
    });
  });
}

function parseGeneratedOutput(rawOutput, target) {
  const files = {};

  // 1. Check ===FILE: path=== blocks (captures all files even if trailing ===END FILE=== is omitted)
  const blockRegex = /===FILE:\s*([^\r\n=]+?)\s*===\r?\n([\s\S]*?)(?=\r?\n===END FILE===|\r?\n===FILE:|$)/g;
  let match;
  while ((match = blockRegex.exec(rawOutput)) !== null) {
    const filePath = match[1].trim();
    const content = match[2].replace(/\r?\n===END FILE===\s*$/, '').trim();
    if (filePath && content) files[filePath] = content;
  }
  if (Object.keys(files).length > 0) return files;

  // 2. Check JSON { "files": { ... } }
  const jsonMatch = rawOutput.match(/\{[\s\S]*"files"\s*:\s*\{[\s\S]*\}[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.files && Object.keys(parsed.files).length > 0) return parsed.files;
    } catch {}
  }

  // 3. Check markdown code fences (```html ... ```, ```css ... ```, ```javascript ... ```)
  const fenceMatch = rawOutput.match(/```(?:html|htm)\r?\n([\s\S]*?)```/i);
  if (fenceMatch) {
    files['index.html'] = fenceMatch[1].trim();
    const cssFence = rawOutput.match(/```css\r?\n([\s\S]*?)```/i);
    if (cssFence && !files['index.html'].includes(cssFence[1].trim().slice(0, 40))) {
      files['styles.css'] = cssFence[1].trim();
    }
    const jsFenceExtra = rawOutput.match(/```(?:javascript|js)\r?\n([\s\S]*?)```/i);
    if (jsFenceExtra && !files['index.html'].includes(jsFenceExtra[1].trim().slice(0, 40))) {
      files['app.js'] = jsFenceExtra[1].trim();
    }
    return files;
  }
  const pyFence = rawOutput.match(/```(?:python|py)\r?\n([\s\S]*?)```/i);
  if (pyFence && target === 'python') {
    files['main.py'] = pyFence[1].trim();
    return files;
  }
  const jsFence = rawOutput.match(/```(?:javascript|js)\r?\n([\s\S]*?)```/i);
  if (jsFence && target === 'node') {
    files['index.js'] = jsFence[1].trim();
    return files;
  }

  // 4. Raw HTML document
  const htmlIdx = rawOutput.search(/<!DOCTYPE html>|<html[\s>]/i);
  if (htmlIdx !== -1) {
    files['index.html'] = rawOutput.slice(htmlIdx).trim();
    return files;
  }

  return null;
}

function isDirectNormalCode(source) {
  const lines = (source || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
  if (!lines.length) return false;

  // If the code mentions visual/vibe app, game, simulation, calculator, or UI entities, use the AI compiler
  const full = lines.join('\n');
  if (
    /\b(game|app|simulation|sim|calculator|calc|program|tool|dashboard|world|scene|view|camera|graphics|shader|lighting|weather|player|npc|enemy|car|zombie|physics|gravity|particles|fluid|orbit|screen|window|theme|ui|button|menu|hud|sound|music|spawn|draw|render|3d|2d|good|realistic|alot)\b/i.test(
      full
    )
  ) {
    return false;
  }

  // Must contain at least one print statement or standard Python construct
  return lines.some((l) => /^print\b/i.test(l) || /^(for|while|def|if|import|from)\b/.test(l) || /^[a-zA-Z_]\w*\s*=\s*[\d"'\[\(\{]/.test(l));
}

function buildDirectOutputHtml(outputText, sourceCode) {
  const escapedOut = String(outputText ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #2b2d30; color: #f1f3f5; font-family: Consolas, 'Courier New', monospace; padding: 24px; height: 100vh; display: flex; flex-direction: column; gap: 14px; }
  .header { font-family: system-ui, sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.8px; color: #b5bac4; text-transform: uppercase; border-bottom: 1px solid #43464d; padding-bottom: 10px; display: flex; justify-content: space-between; }
  .badge { color: #59a869; }
  pre { background: #313338; border: 1px solid #43464d; border-radius: 8px; padding: 18px; font-size: 16px; line-height: 1.6; color: #ffffff; white-space: pre-wrap; word-break: break-word; flex: 1; overflow: auto; }
</style>
</head>
<body>
  <div class="header">
    <span>Direct Code Output</span>
    <span class="badge">⚡ Instant Execution (No AI Needed)</span>
  </div>
  <pre>${escapedOut}</pre>
</body>
</html>`;
}

function getBuildHtmlName(filePath = 'main.py') {
  const safe = path.basename(filePath || 'main.py').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `_build_${safe}.html`;
}

function tryDirectCodeExecution(source, projDir, emit, activeFile = 'main.py') {
  if (!isDirectNormalCode(source)) return null;
  const buildHtmlName = getBuildHtmlName(activeFile);

  return new Promise((resolve) => {
    // Transform bare `print hello 123` lines into a smart Python helper `_cod_print("hello 123", locals())`
    const rawLines = (source || '').split(/\r?\n/);
    const transformed = [
      'def _cod_print(raw_expr, scope):',
      '    try:',
      '        val = eval(raw_expr, globals(), scope)',
      '        print(val)',
      '    except Exception:',
      '        print(raw_expr)',
      ''
    ];

    for (const line of rawLines) {
      const barePrint = line.match(/^(\s*)print\s+(?!\()(.+?)\s*$/i);
      if (barePrint) {
        const indent = barePrint[1];
        const expr = barePrint[2].replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        transformed.push(`${indent}_cod_print("${expr}", locals())`);
      } else {
        transformed.push(line);
      }
    }

    const pyScript = transformed.join('\n');
    const pyBin = process.platform === 'win32' ? 'python' : 'python3';
    execFile(pyBin, ['-c', pyScript], { cwd: projDir, timeout: 4000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) {
        // Fallback: evaluate bare print lines directly in JS if Python errored
        const outLines = [];
        for (const line of rawLines) {
          const m = line.trim().match(/^print\s*(?:\((.*)\)|(.+))$/i);
          if (m) {
            const rawVal = (m[1] !== undefined ? m[1] : m[2]).trim().replace(/^["']|["']$/g, '');
            outLines.push(rawVal);
          }
        }
        if (!outLines.length) return resolve(null);
        const text = outLines.join('\n') + '\n';
        emit('terminal', { stream: 'stdout', text: text.replace(/\n/g, '\r\n') });
        const html = buildDirectOutputHtml(text, source);
        const written = writeFilesToWorkspace(projDir, { [buildHtmlName]: html, '_direct_output.html': html });
        return resolve(written);
      }

      const output = stdout || stderr || '(No output)';
      emit('terminal', { stream: 'stdout', text: output.replace(/\r?\n/g, '\r\n') });
      const html = buildDirectOutputHtml(output, source);
      const written = writeFilesToWorkspace(projDir, { [buildHtmlName]: html, '_direct_output.html': html });
      resolve(written);
    });
  });
}

async function compileWithAI({ provider, ir, source, activeFile = 'main.py', target, projDir, emit }) {
  if (!provider) throw new Error('No AI engine configured.');

  const buildHtmlName = getBuildHtmlName(activeFile);
  const allPyFiles = snapshotPyFiles(projDir);
  allPyFiles[activeFile] = source;

  // Include activeFile + any other .py file ONLY if explicitly imported in source
  const relevantPyFiles = { [activeFile]: source };
  for (const [relPath, content] of Object.entries(allPyFiles)) {
    if (relPath === activeFile) continue;
    const modName = path.basename(relPath, '.py');
    const importRe = new RegExp(`\\b(import|from)\\s+[^\\r\\n]*\\b${modName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (importRe.test(source)) {
      relevantPyFiles[relPath] = content;
    }
  }

  const pyEntries = Object.entries(relevantPyFiles)
    .map(([relPath, content]) => `===SOURCE FILE: ${relPath === activeFile ? 'main_active.py (ACTIVE)' : relPath}===\n${content}\n===END SOURCE FILE===`)
    .join('\n\n');

  // Only load the existing compiled build belonging specifically to THIS activeFile
  const buildFilePath = path.join(projDir, buildHtmlName);
  let prevBuildHtml = null;
  if (fs.existsSync(buildFilePath)) {
    const rawPrev = fs.readFileSync(buildFilePath, 'utf-8');
    if (!rawPrev.includes('<span>Direct Code Output</span>')) {
      prevBuildHtml = rawPrev;
    }
  }

  let existingContext = '';
  if (prevBuildHtml) {
    existingContext = `\nEXISTING GENERATED APPLICATION CODE FOR ${activeFile}:
Below is the previous compiled HTML for ${activeFile}.
- If the user is adding new lines/features or tweaking ${activeFile}, KEEP 100% of the working mechanics, 3D scene/models, controls, and HUD from this code and integrate the new features deeply!
- However, if the user deleted their old instructions in ${activeFile} or changed ${activeFile} to a different concept/game/program, DO NOT keep the old theme — build what ${activeFile} currently asks for!

===EXISTING FILE: index.html===
${prevBuildHtml}
===END EXISTING FILE===\n`;
  }

  const hardModeRule =
    ir.mode === 'hard'
      ? `\nHARD MODE IS ACTIVE (STRICT LITERAL BUILD):
- Build ONLY what the user explicitly wrote in code. Do NOT invent unstated features, extra enemies, extra weapons, or extra UI panels.
- If the user did NOT write \`start_screen = ...\`, \`title_screen = ...\`, or \`menu = ...\`, do NOT create a start screen or title menu—launch directly into the active game/app immediately.`
      : `\nSTRICT CODE FIDELITY:
- Only add a start screen / title menu if the user explicitly wrote \`start_screen = ...\`, \`title_screen = ...\`, or \`menu = ...\`. Otherwise launch directly into the active app/world.`;

  const sharedInstructions = `CRITICAL: Do NOT run any shell commands, do NOT inspect the directory, and do NOT call any tools. Reply immediately in a single response with the complete code.

You are the compiler for "Coding On Drugs". Compile the user's code into a clean, fast, playable, self-contained HTML5/JS application.

USER SOURCE (${activeFile}, Mode: ${ir.mode}):
${pyEntries}
${existingContext}${hardModeRule}

STRICT RULES (FOLLOW EXACTLY):
1. REAL-WORLD COMMON SENSE + STRICT FIDELITY (NO UNREQUESTED BLOAT):
   - Implement EVERY line, entity, trait, and \`if\`/\`when\`/\`every\` rule in the user's code.
   - APPLY REAL-WORLD COMMON SENSE automatically even when numbers aren't specified: give every entity/vehicle/character realistic relative speeds, acceleration, jump height, scale, proportions, and physics (e.g., fast creatures or vehicles move noticeably faster than walking pedestrians).
   - NEVER invent unrequested items, collectibles (NO truffles, coins, gems), quests, timers, scoreboards, enemies, or start/title screens unless the user explicitly wrote them!
   - Launch directly into the playable world/app immediately on load.
2. HIGH-CRAFT 3D GRAPHICS & UNOBSTRUCTED CAMERA:
   - When 3D, first-person, third-person, or good graphics are requested, import Three.js from \`/vendor/three/three.module.js\`.
   - Build recognizable, well-proportioned, multi-part 3D models using sculpted shapes (\`LatheGeometry\`, \`ExtrudeGeometry\`, \`TubeGeometry\`, layered anatomical/mechanical sub-parts, PBR materials, and crisp shadows)—never crude single-primitive blobs.
   - Use rich lighting (directional shadow light + hemisphere light, \`ACESFilmicToneMapping\`, sky/ground).
   - In **first person**, NEVER let the player's own head, neck, or body block the camera view! Keep the camera cleanly at eye level with a 100% unobstructed forward view (rely on cast ground shadows or subtle lower-edge cues when looking down).
3. SILKY-SMOOTH MOVEMENT & LOOKING:
   - Use clamped \`dt\` (\`Math.min(dt, 0.05)\`) with smooth velocity acceleration/damping so movement feels fluid, responsive, and natural.
   - Use \`camera.rotation.order = 'YXZ'\` with clamped pitch and responsive mouse-look that works seamlessly via BOTH Pointer Lock (\`requestPointerLock()\` on canvas click) AND smooth click-and-drag + arrow-key fallback.
4. REAL SOUND EFFECTS (WEB AUDIO API):
   - Whenever the user writes \`sound\`, \`audio\`, \`play ... sound\`, or \`if/when <action> play ...\`, synthesize real procedural Web Audio API sound effects (\`new (window.AudioContext || window.webkitAudioContext)()\`, oscillators + gain envelopes + optional noise buffer) triggered on that exact event (e.g. jump boing/whoosh, laser zap, impact thud). Unlock AudioContext on first keydown/click.
4. OUTPUT FORMAT:
   - Output ONLY a single self-contained \`index.html\` inside:
===FILE: index.html===
<!DOCTYPE html>
...
===END FILE===`;

  if (provider.type === 'cli') {
    const cli = (provider.cli || 'codex').trim();
    const chosenModel = provider.model && provider.model !== 'auto' ? provider.model.trim() : 'gpt-6-sol';

    let rawOutput = '';
    if (cli === 'codex') {
      const codexBin = resolveCodexBinary();
      const outFile = path.join(os.tmpdir(), `codex-out-${Date.now()}.txt`);
      const args = [
        'exec',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        '-c',
        'mcp_servers={}',
        '-c',
        'plugins={}',
        '-c',
        'notify=[]',
        '-c',
        'web_search=disabled',
        '-c',
        'features.memories=false',
        '-c',
        'model_reasoning_effort=medium',
        '-m',
        chosenModel,
        '-o',
        outFile,
        '-'
      ];
      try {
        const res = await runProcess({
          bin: codexBin,
          args,
          prompt: sharedInstructions,
          cwd: projDir,
          emit,
          useShell: false
        });
        rawOutput = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8') : res.stdout;
      } finally {
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch {}
      }
    } else if (cli === 'gemini') {
      const gemModel = chosenModel && chosenModel.startsWith('gemini') ? chosenModel : 'gemini-2.5-flash';
      const args = [
        '-m',
        gemModel,
        '--approval-mode',
        'plan',
        '-e',
        'none',
        '--allowed-mcp-server-names',
        'none',
        '-p',
        'Follow the instructions from stdin and output ONLY the ===FILE: index.html=== block.'
      ];
      const res = await runProcess({
        bin: 'gemini',
        args,
        prompt: sharedInstructions,
        cwd: projDir,
        emit,
        useShell: true
      });
      rawOutput = res.stdout;
    } else {
      const args = chosenModel ? ['-m', chosenModel, '-p', '-'] : ['-p', '-'];
      const res = await runProcess({
        bin: cli,
        args,
        prompt: sharedInstructions,
        cwd: projDir,
        emit,
        useShell: true
      });
      rawOutput = res.stdout;
    }

    const errRegex = /===ERROR:\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^\r\n=]+?)===/g;
    const aiErrors = [];
    let errMatch;
    while ((errMatch = errRegex.exec(rawOutput)) !== null) {
      aiErrors.push({
        severity: 'error',
        line: parseInt(errMatch[1], 10) || 1,
        code: errMatch[2].trim(),
        message: `Hard Mode AI Check: ${errMatch[3].trim()}`
      });
    }
    if (aiErrors.length > 0) {
      const err = new Error(aiErrors.map((e) => e.message).join(' | '));
      err.diagnostics = aiErrors;
      throw err;
    }

    const files = parseGeneratedOutput(rawOutput, target);
    if (!files) {
      throw new Error(`${cli} output could not be parsed into files. Preview: ${rawOutput.slice(0, 200)}`);
    }
    if (files['index.html']) files[buildHtmlName] = files['index.html'];
    return writeFilesToWorkspace(projDir, files);
  }

  if (provider.type === 'ollama') {
    const endpoint = (provider.endpoint || 'http://localhost:11434').replace(/\/$/, '');
    const res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model && provider.model !== 'auto' ? provider.model : 'llama3.2',
        stream: false,
        messages: [{ role: 'user', content: sharedInstructions }]
      })
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const data = await res.json();
    const files = parseGeneratedOutput(data.message?.content || '', target);
    if (!files) throw new Error('Ollama did not return valid file blocks.');
    if (files['index.html']) files[buildHtmlName] = files['index.html'];
    return writeFilesToWorkspace(projDir, files);
  }

  if (isGeminiApiProvider(provider)) {
    const token = (provider.token || '').trim();
    if (!token) throw new Error('Google Gemini API Key is required. Paste your key (starts with AIza...) in Settings.');
    const model = provider.model && provider.model.startsWith('gemini') ? provider.model : 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: sharedInstructions }] }]
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini API HTTP ${res.status}: ${errText.slice(0, 160)}`);
    }
    const data = await res.json();
    const rawText = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
    const files = parseGeneratedOutput(rawText, target);
    if (!files) throw new Error('Gemini API did not return valid file blocks.');
    if (files['index.html']) files[buildHtmlName] = files['index.html'];
    return writeFilesToWorkspace(projDir, files);
  }

  if (provider.type === 'grok') {
    const status = getGrokAuthStatus();
    if (!status.installed) {
      throw new Error('Grok CLI is not installed. Install it with: curl -fsSL https://x.ai/cli/install.sh | bash');
    }
    if (!status.loggedIn) {
      throw new Error('Grok is not signed in. Click Sign in with Grok in Settings.');
    }
    const model = grokModel(provider);
    const promptFile = path.join(os.tmpdir(), `cod-grok-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, sharedInstructions, 'utf8');
    try {
      let result;
      try {
        result = await runGrokHeadless({
          bin: resolveGrokBinary(),
          args: [
            '--no-auto-update',
            '--no-alt-screen',
            '--verbatim',
            '--disable-web-search',
            '--max-turns', '1',
            '--reasoning-effort', 'low',
            '-m', model,
            '--output-format', 'streaming-json',
            '--prompt-file', promptFile
          ],
          cwd: projDir,
          emit,
          env: grokCliEnv()
        });
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          throw new Error('Grok CLI is not installed. Install it with: curl -fsSL https://x.ai/cli/install.sh | bash');
        }
        throw err;
      }
      const files = parseGeneratedOutput(result.text || result.stdout, target);
      if (!files) throw new Error('Grok did not return valid file blocks.');
      if (files['index.html']) files[buildHtmlName] = files['index.html'];
      return writeFilesToWorkspace(projDir, files);
    } finally {
      try { fs.unlinkSync(promptFile); } catch {}
    }
  }

  if (provider.type === 'openai-compatible') {
    const endpoint = (provider.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '');
    const token = (provider.token || '').trim();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const model = provider.model && provider.model !== 'auto' && !provider.model.includes('-sol') && !provider.model.includes('-luna') ? provider.model : 'gpt-4o-mini';
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: sharedInstructions }]
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`API returned HTTP ${res.status}: ${errText.slice(0, 160)}`);
    }
    const data = await res.json();
    const files = parseGeneratedOutput(data.choices?.[0]?.message?.content || '', target);
    if (!files) throw new Error('Provider did not return valid file blocks.');
    if (files['index.html']) files[buildHtmlName] = files['index.html'];
    return writeFilesToWorkspace(projDir, files);
  }

  throw new Error(`Unknown provider type: ${provider.type}`);
}

function writeFilesToWorkspace(workspaceDir, files) {
  const written = [];
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(workspaceDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const prev = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : null;
    if (prev !== content) {
      fs.writeFileSync(fullPath, content, 'utf-8');
      written.push({ path: relPath, status: prev === null ? 'created' : 'updated' });
    } else {
      written.push({ path: relPath, status: 'unchanged' });
    }
  }
  return written;
}

module.exports = {
  parseInstructions,
  validateCodeSyntax,
  validateHardMode,
  detectTarget,
  getCodexCatalog,
  resolveCodexBinary,
  resolveGrokBinary,
  grokCliEnv,
  getGrokAuthStatus,
  getBuildHtmlName,
  tryDirectCodeExecution,
  compileWithAI,
  cancelActiveBuild,
  testAIProvider,
  writeFilesToWorkspace
};
