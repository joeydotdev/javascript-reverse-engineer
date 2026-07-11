(self.webpackChunkapp=self.webpackChunkapp||[]).push([[0],{
  101: function(e, t, n) {
    "use strict";
    t.greet = function(name) { return "hello " + name; };
  },
  202: function(e, t, n) {
    "use strict";
    var g = n(101);
    t.run = function() { console.log(g.greet("world")); };
  },
  303: function(e, t, n) {
    "use strict";
    t.VERSION = "1.0.0";
  }
}]);
