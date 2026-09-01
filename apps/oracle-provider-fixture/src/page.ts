import type { FixtureScenario, FixtureTurn } from "./types.js";

export interface FixturePageBootstrap {
  jobId: string;
  scenario: FixtureScenario;
  turn?: FixtureTurn;
}

export function fixturePage(bootstrap: FixturePageBootstrap): string {
  const encoded = JSON.stringify(bootstrap).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en-US">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Oracle Provider Fixture</title>
  <style>
    body { font: 15px system-ui; margin: 0; background: #f7f7f5; color: #171717; }
    header, main { max-width: 760px; margin: auto; padding: 18px; }
    #controls, #composer-shell { display: flex; gap: 10px; align-items: center; margin: 12px 0; }
    textarea, [contenteditable="true"] { min-height: 120px; flex: 1; padding: 12px; background: white; border: 1px solid #aaa; }
    article { background: white; border: 1px solid #ddd; border-radius: 10px; padding: 14px; margin: 10px 0; white-space: pre-wrap; }
    [role=menu] { background: white; border: 1px solid #bbb; padding: 8px; }
    [data-attachment-chip] { background: #e7edf8; border-radius: 99px; padding: 5px 9px; }
    [data-remove-attachment] { width: 18px; height: 18px; margin-left: 6px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <header><strong>Oracle Provider Fixture</strong></header>
  <main id="app"></main>
  <script>window.__ORACLE_FIXTURE__ = ${encoded};</script>
  <script>
  (() => {
    const boot = window.__ORACLE_FIXTURE__;
    const app = document.querySelector('#app');
    const scenario = boot.scenario;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const escapeHtml = (value) => String(value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    const sha256 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');

    function renderTurn(turn) {
      if (!turn || !turn.committed) return;
      const conversation = document.querySelector('[data-testid="conversation-root"]');
      if (!conversation) return;
      conversation.innerHTML = '';
      const attachment = turn.bundleSha256
        ? (scenario === 'aria-file-tile-attachment'
          ? '<button type="button" aria-label="' + escapeHtml(turn.bundleFilename) + '">' + escapeHtml(turn.bundleFilename) + '</button>'
          : '<span data-testid="conversation-turn-attachment" aria-label="Attached file ' + escapeHtml(turn.bundleFilename) + '">' + escapeHtml(turn.bundleFilename) + '</span>')
        : '';
      conversation.insertAdjacentHTML('beforeend',
        '<article data-testid="conversation-turn-user" data-message-author-role="user">' +
        '<div class="whitespace-pre-wrap">' + escapeHtml(turn.prompt) + '</div>' + attachment + '</article>');
      const assistant = document.createElement('article');
      assistant.dataset.testid = 'conversation-turn-assistant';
      assistant.dataset.messageAuthorRole = 'assistant';
      const content = document.createElement('div');
      content.className = 'markdown';
      assistant.append(content);
      if (scenario !== 'copy-control-missing') {
        const copy = document.createElement('button');
        copy.dataset.testid = 'copy-turn-action-button';
        copy.setAttribute('aria-label', 'Copy');
        copy.textContent = 'Copy';
        copy.addEventListener('click', () => { window.__ORACLE_COPIED_MARKDOWN__ = turn.assistantMarkdown; });
        assistant.append(copy);
      }
      const good = document.createElement('button');
      good.dataset.testid = 'good-response-turn-action-button';
      good.setAttribute('aria-label', 'Good response');
      assistant.append(good);
      conversation.append(assistant);
      if (scenario === 'streaming-assistant') {
        assistant.dataset.streaming = 'true';
        content.textContent = turn.assistantMarkdown.slice(0, Math.max(1, Math.floor(turn.assistantMarkdown.length / 2)));
        setTimeout(() => {
          content.innerHTML = turn.assistantHtml;
          assistant.dataset.streaming = 'false';
        }, 90);
      } else {
        assistant.dataset.streaming = 'false';
        content.innerHTML = turn.assistantHtml;
      }
    }

    async function mount() {
      if (scenario === 'auth-required') {
        app.innerHTML = '<button aria-label="Log in">Log in</button>';
        return;
      }
      if (scenario === 'delayed-composer') await delay(75);
      const unknown = scenario === 'unknown-ui-fingerprint';
      const known = !unknown;
      app.innerHTML =
        (scenario === 'rate-limit' ? '<div role="alert">Rate limit reached</div>' : '') +
        '<form id="composer-shell" ' + (known ? 'data-type="unified-composer" ' : '') + '>' +
        '<section id="controls">' +
        '<button type="button" ' + (known ? 'data-testid="model-switcher-dropdown-button" class="__composer-pill" ' : '') +
        'aria-label="' + (unknown ? 'Mystery control' : 'Model and intelligence') + '" aria-haspopup="menu">Pro</button>' +
        '<div role="menu" ' + (known ? 'data-testid="composer-intelligence-picker-content" ' : '') + 'class="hidden">' +
        '<button type="button" role="menuitemradio" aria-checked="true" ' +
        (known ? 'data-composer-intelligence-pro-effort-action="true" ' : '') + '>Pro Maximum intelligence</button>' +
        '<button type="button" role="menuitem">Advanced</button>' +
        '<div ' + (known ? 'data-testid="composer-model-picker-slider-advanced-view" ' : '') + '>' +
        '<button type="button" role="menuitemradio" ' + (known ? 'data-testid="model-switcher-gpt-5-6-sol" ' : '') + 'aria-checked="true">GPT-5.6 Sol</button>' +
        '</div>' +
        '<label>Intelligence <input ' + (known ? 'data-testid="composer-model-picker-power-slider" ' : '') +
        'aria-label="Intelligence" role="slider" type="range" min="1" max="5" value="5"></label>' +
        '</div>' +
        '</section>' +
        '<button type="button" ' + (known ? 'id="composer-plus-btn" data-testid="composer-plus-btn" ' : '') +
        'aria-label="' + (unknown ? 'Unknown action' : 'Add files and more') + '">Attach</button>' +
        '<input type="file" class="hidden" data-upload-input>' +
        '<div data-upload-status></div><div data-attachment-list></div>' +
        (known ? '<textarea name="prompt-textarea" class="hidden wcDTda_fallbackTextarea"></textarea>' : '') +
        '<div ' + (known ? 'id="prompt-textarea" data-id="prompt-textarea" ' : '') +
        'contenteditable="true" role="textbox" aria-label="' + (unknown ? 'Unknown input' : 'Prompt') + '"></div>' +
        '<button type="submit" ' + (known ? 'data-testid="send-button" ' : '') + 'aria-label="Send message" disabled>Send</button>' +
        '</form>' +
        '<section data-testid="conversation-root"></section>';

      const modelButton = document.querySelector('button[aria-haspopup="menu"]');
      const menu = document.querySelector('[role="menu"]');
      if (scenario === 'conversation-history-rate-limit-modal') {
        modelButton.classList.add('hidden');
        setTimeout(() => {
          const modal = document.createElement('div');
          modal.dataset.testid = 'modal-conversation-history-rate-limit';
          modal.style.position = 'fixed';
          modal.style.inset = '0';
          modal.style.zIndex = '1000';
          modal.style.background = 'white';
          const dismiss = document.createElement('button');
          dismiss.type = 'button';
          dismiss.textContent = 'Got it';
          dismiss.addEventListener('click', () => modal.remove());
          modal.append(dismiss);
          document.body.append(modal);
          modelButton.classList.remove('hidden');
        }, 75);
      }
      modelButton.addEventListener('click', () => menu.classList.toggle('hidden'));
      menu.querySelector('[data-testid^="model-switcher-"]').addEventListener('click', () => {
        modelButton.textContent = 'GPT-5.6 Sol';
        menu.classList.add('hidden');
      });

      const input = document.querySelector('[data-upload-input]');
      const attachButton = document.querySelector('#composer-shell > button');
      const status = document.querySelector('[data-upload-status]');
      const attachments = document.querySelector('[data-attachment-list]');
      const composer = document.querySelector('[contenteditable="true"]');
      const send = document.querySelector('[data-testid="send-button"]');
      const composerText = () => (composer.innerText ?? '')
        .replace(/\\n{2,}/g, (run) => '\\n'.repeat(Math.ceil(run.length / 2)))
        .trim();
      const updateSend = () => {
        const bundleReady = !input.files.length || attachments.querySelectorAll('[data-testid="composer-attachment"], [data-fixture-file-tile]').length === 1;
        send.disabled = composerText().length === 0 || !bundleReady || scenario === 'rate-limit';
      };
      composer.addEventListener('input', updateSend);
      attachButton.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        attachments.innerHTML = '';
        status.setAttribute('role', 'status');
        status.textContent = 'Uploading';
        const file = input.files[0];
        if (!file) return;
        const digest = await sha256(await file.arrayBuffer());
        input.__oracleFixtureSha256 = digest;
        if (scenario === 'attachment-chip-delay') await delay(80);
        status.textContent = '';
        if (scenario !== 'missing-attachment') {
          const count = scenario === 'duplicate-filename' ? 2 : 1;
          const displayedFilename = scenario === 'aria-file-tile-attachment'
            ? file.name.replace(/([.][^.]+)$/, '(2)$1')
            : file.name;
          for (let index = 0; index < count; index += 1) {
            attachments.insertAdjacentHTML('beforeend', scenario === 'aria-file-tile-attachment'
              ? '<span data-fixture-file-tile aria-label="' + escapeHtml(displayedFilename) + '">' +
                '<button type="button" aria-label="' + escapeHtml(displayedFilename) + '"></button>' +
                '<span data-attachment-name>' + escapeHtml(displayedFilename) + '</span></span>'
              : '<span data-testid="composer-attachment">' +
                '<span data-attachment-name>' + escapeHtml(file.name) + '</span>' +
                '<button type="button" data-remove-attachment aria-label="Remove attachment"></button></span>');
          }
          for (const remove of attachments.querySelectorAll('[data-remove-attachment]')) {
            remove.addEventListener('click', () => {
              remove.closest('[data-testid="composer-attachment"], [data-fixture-file-tile]')?.remove();
              input.value = '';
              input.__oracleFixtureSha256 = undefined;
              updateSend();
            });
          }
        }
        updateSend();
      });
      send.addEventListener('click', async (event) => {
        event.preventDefault();
        send.disabled = true;
        const prompt = composerText();
        const receipt = prompt.match(/\\[Oracle receipt: job=([^;]+); turn=([^;]+);/);
        const chip = attachments.querySelector('[data-testid="composer-attachment"], [data-fixture-file-tile]');
        const response = await fetch('/api/send', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobId: boot.jobId,
            turnAttemptId: receipt ? receipt[2] : 'missing',
            prompt,
            bundleSha256: chip ? input.__oracleFixtureSha256 : undefined,
            bundleFilename: chip?.textContent,
            scenario,
          }),
        });
        const turn = await response.json();
        if (!turn.committed) return;
        renderTurn(turn);
        const bind = () => history.replaceState({}, '', turn.conversationUrl);
        if (scenario === 'late-conversation-url') {
          setTimeout(bind, 80);
        } else if (scenario === 'provisional-conversation-url') {
          history.replaceState({}, '', '/c/WEB:fixture-request-id');
          setTimeout(bind, 1000);
        } else {
          bind();
        }
        if (scenario === 'conversation-rollback-after-commit') {
          setTimeout(() => {
            history.replaceState({}, '', '/');
            document.querySelector('[data-testid="conversation-root"]')?.replaceChildren();
          }, 150);
        }
        if (scenario === 'wrong-conversation-navigation') {
          setTimeout(() => history.replaceState({}, '', '/c/wrong-conversation'), 35);
        }
      });
      renderTurn(boot.turn);
    }
    void mount();
  })();
  </script>
</body>
</html>`;
}
