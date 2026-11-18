/* Tiny RSVP donut geometry shared by the panel and its unit tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RsvpChart = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function segments(counts) {
    var source = counts || {};
    var values = ['accepted', 'tentative', 'declined', 'noResponse'].map(function (key) {
      var n = Number(source[key]);
      return Number.isFinite(n) && n > 0 ? n : 0;
    });
    var total = values.reduce(function (sum, n) { return sum + n; }, 0);
    var cursor = 0;
    var items = values.map(function (count, index) {
      var percent = total ? (count / total) * 100 : 0;
      var item = {
        key: ['accepted', 'tentative', 'declined', 'noResponse'][index],
        label: ['Accepted', 'Maybe', 'Declined', 'No reply'][index],
        count: count,
        percent: percent,
        startPercent: cursor
      };
      cursor += percent;
      return item;
    });
    return { total: total, items: items };
  }

  return { segments: segments };
});
