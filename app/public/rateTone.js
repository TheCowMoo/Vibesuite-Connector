/* Shared Yes-rate KPI bands, used by the panel and its unit tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RateTone = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // The KPI is > 70%; exactly 70 is still in the watch band.
  var GREEN_ABOVE = 70;
  var YELLOW_FROM = 50;

  function usable(rate, hasData) {
    return hasData === true && typeof rate === 'number' && isFinite(rate);
  }

  function classify(rate, hasData) {
    if (!usable(rate, hasData)) return { tone: 'neutral', label: 'No replies' };
    if (rate > GREEN_ABOVE) return { tone: 'success', label: 'On target' };
    if (rate >= YELLOW_FROM) return { tone: 'warning', label: 'Watch' };
    return { tone: 'danger', label: 'Below target' };
  }

  function format(rate, hasData) {
    if (!usable(rate, hasData)) return '—';
    return String(Math.round(rate * 10) / 10) + '%';
  }

  return {
    classify: classify,
    format: format,
    GREEN_ABOVE: GREEN_ABOVE,
    YELLOW_FROM: YELLOW_FROM
  };
});
