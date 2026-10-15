/*
 * LambdaTeX: show/hide toggle for password fields on the server-rendered
 * sign-in and password pages. nginx adds this script with the page's own CSP
 * nonce (deploy/branding/nginx/), so the Content Security Policy stays intact.
 *
 * Icons: Lucide "eye" and "eye-off" (ISC licence, https://lucide.dev).
 */
;(function () {
  'use strict'

  var SVG_ATTRS =
    'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" focusable="false"'
  var EYE =
    '<svg ' + SVG_ATTRS + ' class="lucide lucide-eye h-4 w-4">' +
    '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>' +
    '<circle cx="12" cy="12" r="3"/></svg>'
  var EYE_OFF =
    '<svg ' + SVG_ATTRS + ' class="lucide lucide-eye-off h-4 w-4">' +
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>' +
    '<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>' +
    '<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>' +
    '<path d="m2 2 20 20"/></svg>'

  function enhance(input) {
    if (input.hasAttribute('data-lt-password-toggle')) return
    input.setAttribute('data-lt-password-toggle', '')

    var field = document.createElement('div')
    field.className = 'lt-password-field'
    input.parentNode.insertBefore(field, input)
    field.appendChild(input)

    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'lt-password-toggle'
    if (input.id) button.setAttribute('aria-controls', input.id)

    function render(visible) {
      button.innerHTML = visible ? EYE_OFF : EYE
      button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password')
      button.setAttribute('aria-pressed', visible ? 'true' : 'false')
      button.title = visible ? 'Hide password' : 'Show password'
    }

    button.addEventListener('click', function () {
      var visible = input.type === 'password'
      var start = input.selectionStart
      var end = input.selectionEnd
      input.type = visible ? 'text' : 'password'
      render(visible)
      input.focus()
      try {
        input.setSelectionRange(start, end)
      } catch (e) {}
    })

    // Hand the password back to the browser hidden, so it is never submitted
    // or remembered while visible.
    if (input.form) {
      input.form.addEventListener('submit', function () {
        input.type = 'password'
        render(false)
      })
    }

    render(false)
    field.appendChild(button)
  }

  function run() {
    var inputs = document.querySelectorAll(
      'form[data-ol-async-form] input[type="password"], .auth-aux-container input[type="password"]'
    )
    for (var i = 0; i < inputs.length; i++) enhance(inputs[i])
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run)
  } else {
    run()
  }
})()

/*
 * LambdaTeX: Manual / Auto mode for edits proposed by the AI assistant.
 *
 * Manual (default) keeps upstream's behaviour: each replace_lines edit waits as
 * a diff with Reject / Apply. Auto applies each edit that arrives while Auto is
 * on, one at a time, by pressing the app's own Apply button, so the app still
 * opens the file, checks the replaced text and reports back to the AI. Undo
 * stays available on every applied edit. Edits already waiting when Auto is
 * switched on are left for the user. The choice is remembered per browser.
 *
 * Icons: Lucide "hand" and "zap" (ISC licence, https://lucide.dev).
 */
;(function () {
  'use strict'

  var KEY = 'lambdatex.aiEditMode'
  var mode = readMode()
  var seen = Object.create(null) // fingerprints never to auto-apply
  var queue = []
  var busy = false
  var scheduled = false

  function readMode() {
    try {
      return window.localStorage.getItem(KEY) === 'auto' ? 'auto' : 'manual'
    } catch (e) {
      return 'manual'
    }
  }

  function saveMode(value) {
    try {
      window.localStorage.setItem(KEY, value)
    } catch (e) {}
  }

  var SVG_ATTRS =
    'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" focusable="false"'
  var HAND =
    '<svg ' + SVG_ATTRS + ' class="lucide lucide-hand h-4 w-4">' +
    '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/>' +
    '<path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>' +
    '<path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/>' +
    '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>'
  var ZAP =
    '<svg ' + SVG_ATTRS + ' class="lucide lucide-zap h-4 w-4">' +
    '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>'

  var OPTIONS = [
    ['manual', HAND, 'Manual', 'Manual: review each AI edit and apply it yourself'],
    ['auto', ZAP, 'Auto', 'Auto: apply AI edits as they arrive (Undo stays available)'],
  ]

  // A pending suggestion shows Reject + Apply (with the arrow icon). The card
  // shown after applying has a single Undo (or re-Apply) button, never two.
  function applyButton(card) {
    var groups = card.querySelectorAll('.workbench-code-diff-actions > div')
    var group = groups[groups.length - 1]
    if (!group) return null
    var buttons = group.querySelectorAll('button')
    if (buttons.length !== 2) return null
    var icon = buttons[1].querySelector('.material-symbols')
    return icon && icon.textContent.trim() === 'arrow_right_alt' ? buttons[1] : null
  }

  function fingerprint(card) {
    var code = card.querySelector('.workbench-code-diff') || card
    return code.textContent.replace(/\s+/g, ' ').trim()
  }

  function pendingCards() {
    var cards = document.querySelectorAll('.workbench-panel .workbench-code-suggestion')
    return Array.prototype.filter.call(cards, function (card) {
      return applyButton(card) !== null
    })
  }

  function renderToggles() {
    var buttons = document.querySelectorAll('.lt-ai-mode-option')
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-mode') === mode
      buttons[i].setAttribute('aria-checked', on ? 'true' : 'false')
      buttons[i].classList.toggle('is-active', on)
    }
  }

  function buildToggle() {
    var group = document.createElement('div')
    group.className = 'lt-ai-mode'
    group.setAttribute('role', 'radiogroup')
    group.setAttribute('aria-label', 'AI edits')
    OPTIONS.forEach(function (option) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'lt-ai-mode-option'
      button.setAttribute('data-mode', option[0])
      button.setAttribute('role', 'radio')
      button.title = option[3]
      button.innerHTML = option[1] + '<span>' + option[2] + '</span>'
      button.addEventListener('click', function () {
        switchMode(option[0])
      })
      group.appendChild(button)
    })
    return group
  }

  // Sits next to the attach / tools / model buttons under the prompt.
  function ensureToggle() {
    var rows = document.querySelectorAll(
      '.workbench-panel .workbench-prompt-input .align-items-end.justify-content-between'
    )
    for (var i = 0; i < rows.length; i++) {
      var left = rows[i].firstElementChild
      if (left && !rows[i].querySelector('.lt-ai-mode')) left.appendChild(buildToggle())
    }
    renderToggles()
  }

  function switchMode(next) {
    if (next === mode) return
    mode = next
    saveMode(next)
    if (next === 'auto') {
      // Only edits that arrive from now on are applied automatically.
      pendingCards().forEach(function (card) {
        seen[fingerprint(card)] = true
      })
    } else {
      queue = []
    }
    renderToggles()
  }

  function pump() {
    if (busy || mode !== 'auto') return
    var fp = queue.shift()
    if (fp === undefined) return
    var card = pendingCards().filter(function (c) {
      return fingerprint(c) === fp
    })[0]
    if (!card) return pump()
    busy = true
    card.classList.add('lt-ai-auto-applying')
    var started = Date.now()
    var finish = function () {
      busy = false
      pump()
    }
    var stillPending = function () {
      return pendingCards().some(function (c) {
        return fingerprint(c) === fp
      })
    }
    ;(function press() {
      if (mode !== 'auto') {
        card.classList.remove('lt-ai-auto-applying')
        busy = false
        return
      }
      var button = card.isConnected ? applyButton(card) : null
      if (!button) return finish()
      if (button.disabled) {
        return Date.now() - started < 15000 ? setTimeout(press, 200) : finish()
      }
      button.click()
      // Wait until the app has applied it (the card leaves the pending state).
      ;(function wait() {
        if (!stillPending() || Date.now() - started > 15000) return finish()
        setTimeout(wait, 150)
      })()
    })()
  }

  function scan() {
    scheduled = false
    ensureToggle()
    if (mode !== 'auto') return
    pendingCards().forEach(function (card) {
      var fp = fingerprint(card)
      if (!seen[fp]) {
        seen[fp] = true
        queue.push(fp)
      }
    })
    pump()
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    setTimeout(scan, 150)
  }

  function start() {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
    schedule()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
