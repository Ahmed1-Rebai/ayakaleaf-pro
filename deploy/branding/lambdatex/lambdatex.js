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
