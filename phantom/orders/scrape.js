/**
 * Sandcrawler Phantom Scrape Order
 * =================================
 *
 * Scraping job handler function.
 */
var webpage = require('webpage'),
    helpers = require('../../src/helpers.js'),
    extend = helpers.extend;

module.exports = function(parent, params) {

  return function(msg) {
    var order = msg.body,
        callId = msg.id;

    // Order's lifespan
    var lifespan = order.timeout || 5000;

    // Creating webpage
    var page = webpage.create();

    // Applying precise page settings
    page.settings = extend(order.page, page.settings);

    // Checking headers for User-Agent
    if (order.headers) {
      var values = [],
          names = Object.keys(order.headers).map(function(n) {
            values.push(order.headers[n]);
            return n.toLowerCase();
          });

      var idx = names.indexOf('user-agent');

      if (~idx)
        page.settings.userAgent = values[idx];
    }

    /**
     * Enhancing webpage
     */

    // Fallback response object
    page.response = {};
    page.error = {};
    page.isOpened = false;

    function injectArtoo() {

      // jQuery
      page.injectJs(params.paths.jquery);
      page.evaluate(function() {
        window.artooPhantomJQuery = window.jQuery.noConflict();
      });

      // Settings
      page.evaluate(function(jsonSettings) {
        var settings = document.createElement('div');
        settings.setAttribute('id', 'artoo_injected_script');
        settings.setAttribute('settings', jsonSettings);

        document.documentElement.appendChild(settings);
      }, JSON.stringify(order.artoo));

      // artoo (this will eradicate our jQuery version from window)
      page.injectJs(params.paths.artoo);
    }

    // Kill
    function cleanup() {
      if (page.timeout)
        clearTimeout(page.timeout);

      page.close();
    }

    // Creating timeout
    page.timeout = setTimeout(cleanup, lifespan);

    /**
     * Helpers
     */

    // Wrapping response helper
    function wrapFailure(reason) {
      var res = {
        fail: true,
        url: page.url,
        headers: page.response.headers,
        status: page.response.status
      };

      if (reason)
        res.reason = reason;

      if (page.error)
        res.error = page.error;

      return res;
    }

    // Wrapping success helper
    function wrapSuccess(result) {
      return {
        url: page.url,
        headers: page.response.headers,
        status: page.response.status,
        error: result.error ? helpers.serializeError(result.error) : null,
        data: result.data
      };
    }

    // Wrapping data helper
    function wrapData(o) {
      return {
        data: o,
        callId: callId
      };
    }

    /**
     * Registering global page callbacks
     */

    // On url changed, we track it
    // TODO: track redirects
    page.onUrlChanged = function(targetUrl) {
      order.url = targetUrl;
    };

    // On resource received
    page.onResourceReceived = function(response) {
      if (page.isOpened || response.url !== order.url)
        return;

      // Is the resource matching the page's url?
      page.response = response;
    };

    // On resource error
    page.onResourceError = function(error) {
      if (error.url === order.url || !!~error.url.search(order.url))
        page.error = error;
    };

    // On page callback
    page.onCallback = function(msg) {
      msg = msg || {};

      // If the passphrase is wrong, we break
      if (typeof msg !== 'object' || msg.passphrase !== 'detoo')
        return;

      // Body is now loaded
      if (msg.head === 'documentReady' && page.onDocumentReady)
        return page.onDocumentReady();

      // Page is trying to close phantom
      // NOTE: cleanup is async here to avoid page log generated by
      // phantomjs pages teardown process.
      if (msg.head === 'exit') {
        cleanup();
        return setTimeout(function() {
          phantom.exit(msg.body || 0);
        }, 0);
      }

      // Page is returning control
      if (msg.head === 'done') {

        // On retrieve data, we send back to parent
        parent.replyTo(callId, wrapSuccess(msg.body));

        // Closing
        return cleanup();
      }
    };

    // On body loaded
    page.onDocumentReady = function() {

      // Injecting necessary javascript
      injectArtoo();

      // Evaluating scraper
      if (order.synchronousScript) {
        var data = page.evaluate(order.script);

        // Replying to parent
        parent.replyTo(callId, wrapSuccess({data: data}));

        // Closing
        return cleanup();
      }
      else {
        page.evaluateAsync(order.script);
      }
    };

    // On page console message
    page.onConsoleMessage = function(message, lineNum, sourceId) {

      // Sending back to parent
      parent.send('page:log', wrapData({
        message: message,
        line: lineNum,
        source: sourceId
      }));
    };

    // On page error
    page.onError = function(message, trace) {

      // Sending back to parent
      parent.send('page:error', wrapData({
        message: message,
        trace: trace
      }));
    };

    // On page alert
    page.onAlert = function(message) {

      // Sending back to parent
      parent.send('page:alert', wrapData({
        message: message
      }));
    };

    // On navigation
    var firstTime = true;
    page.onNavigationRequested = function(url, type, willNavigate) {

      if (firstTime)
        return (firstTime = false);

      if (!willNavigate)
        return;

      // Caching the callback

      parent.send('page:navigation', wrapData({
        to: url,
        type: type
      }));
    };

    // When page load is finished
    page.onLoadFinished = function(status) {

      // Page is now opened
      page.isOpened = true;

      // Failing
      if (status !== 'success') {
        parent.replyTo(callId, wrapFailure('fail'));
        return cleanup();
      }

      // Wrong status code
      if (!page.response.status || page.response.status >= 400) {
        parent.replyTo(callId, wrapFailure('status'));
        return cleanup();
      }

      // Waiting for body to load
      page.evaluateAsync(function() {
        var interval = setInterval(function() {
          if (document.readyState === 'complete') {
            clearInterval(interval);
            window.callPhantom({
              head: 'documentReady',
              body: true,
              passphrase: 'detoo'
            });
          }
        }, 30);
      });
    };

    /**
     * Opening url
     */
    var request = {
      encoding: order.encoding || 'utf-8',
      operation: order.method || 'GET'
    };

    if (order.headers)
      request.headers = order.headers;

    if (order.body)
      request.data = order.body;

    page.open(order.url, request);
  };
};
