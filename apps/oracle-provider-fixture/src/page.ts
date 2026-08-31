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
    textarea { min-height: 120px; flex: 1; padding: 12px; }
    article { background: white; border: 1px solid #ddd; border-radius: 10px; padding: 14px; margin: 10px 0; white-space: pre-wrap; }
    [role=menu] { background: white; border: 1px solid #bbb; padding: 8px; }
    [data-attachment-chip] { background: #e7edf8; border-radius: 99px; padding: 5px 9px; }
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
      const conversation = document.querySelector('[data-testid="conversation-turns"]');
      if (!conversation) return;
      conversation.innerHTML = '';
      const attachment = turn.bundleSha256
        ? '<span data-committed-attachment data-artifact-sha256="' + escapeHtml(turn.bundleSha256) + '">' + escapeHtml(turn.bundleFilename) + '</span>'
        : '';
      conversation.insertAdjacentHTML('beforeend',
        '<article data-message-author-role="user" data-conversation-id="' + escapeHtml(turn.conversationId) + '">' +
        '<div data-message-content>' + escapeHtml(turn.prompt) + '</div>' + attachment + '</article>');
      const assistant = document.createElement('article');
      assistant.dataset.messageAuthorRole = 'assistant';
      assistant.dataset.conversationId = turn.conversationId;
      const content = document.createElement('div');
      content.dataset.messageContent = '';
      assistant.append(content);
      if (scenario !== 'copy-control-missing') {
        const copy = document.createElement('button');
        copy.setAttribute('aria-label', 'Copy response');
        copy.textContent = 'Copy';
        copy.addEventListener('click', () => { window.__ORACLE_COPIED_MARKDOWN__ = turn.assistantMarkdown; });
        assistant.append(copy);
      }
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
      app.innerHTML =
        (scenario === 'rate-limit' ? '<div role="alert">Rate limit reached</div>' : '') +
        '<section id="controls">' +
        '<button aria-label="' + (unknown ? 'Mystery control' : 'Choose model') + '" aria-haspopup="menu">GPT-5.6 Sol</button>' +
        '<div role="menu" class="hidden"><button role="menuitemradio">GPT-5.6 Sol</button></div>' +
        '<label>Reasoning effort <input aria-label="Reasoning effort" type="range" min="1" max="5" value="5"></label>' +
        '</section>' +
        '<section id="composer-shell">' +
        '<button aria-label="' + (unknown ? 'Unknown action' : 'Attach files') + '">Attach</button>' +
        '<input type="file" class="hidden" data-upload-input>' +
        '<div data-upload-status></div><div data-attachment-list></div>' +
        '<textarea aria-label="' + (unknown ? 'Unknown input' : 'Message ChatGPT') + '"></textarea>' +
        '<button data-testid="send-button" aria-label="Send prompt" disabled>Send</button>' +
        '</section>' +
        '<section data-testid="conversation-turns"></section>';

      const modelButton = document.querySelector('button[aria-haspopup="menu"]');
      const menu = document.querySelector('[role="menu"]');
      modelButton.addEventListener('click', () => menu.classList.toggle('hidden'));
      menu.querySelector('[role="menuitemradio"]').addEventListener('click', () => {
        modelButton.textContent = 'GPT-5.6 Sol';
        menu.classList.add('hidden');
      });

      const input = document.querySelector('[data-upload-input]');
      const attachButton = document.querySelector('#composer-shell > button');
      const status = document.querySelector('[data-upload-status]');
      const attachments = document.querySelector('[data-attachment-list]');
      const composer = document.querySelector('textarea');
      const send = document.querySelector('[data-testid="send-button"]');
      const updateSend = () => {
        const bundleReady = !input.files.length || attachments.querySelectorAll('[data-attachment-chip]').length === 1;
        send.disabled = composer.value.trim().length === 0 || !bundleReady || scenario === 'rate-limit';
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
        if (scenario === 'attachment-chip-delay') await delay(80);
        status.textContent = '';
        if (scenario !== 'missing-attachment') {
          const count = scenario === 'duplicate-filename' ? 2 : 1;
          for (let index = 0; index < count; index += 1) {
            attachments.insertAdjacentHTML('beforeend', '<span data-attachment-chip data-artifact-sha256="' + digest + '">' + escapeHtml(file.name) + '</span>');
          }
        }
        updateSend();
      });
      send.addEventListener('click', async () => {
        send.disabled = true;
        const prompt = composer.value;
        const receipt = prompt.match(/\\[Oracle receipt: job=([^;]+); turn=([^;]+);/);
        const chip = attachments.querySelector('[data-attachment-chip]');
        const response = await fetch('/api/send', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobId: boot.jobId,
            turnAttemptId: receipt ? receipt[2] : 'missing',
            prompt,
            bundleSha256: chip?.dataset.artifactSha256,
            bundleFilename: chip?.textContent,
            scenario,
          }),
        });
        const turn = await response.json();
        if (!turn.committed) return;
        renderTurn(turn);
        const bind = () => history.replaceState({}, '', turn.conversationUrl);
        if (scenario === 'late-conversation-url') setTimeout(bind, 80); else bind();
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
