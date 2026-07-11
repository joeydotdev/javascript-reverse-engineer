(function(r) {
    var h = window.AmazonUIPageJS || window.P;
    var e = h._namespace || h.attributeErrors;
    var a = e ? e("MyAssets", "") : h;
    a.guardFatal ? a.guardFatal(r)(a, window) : a.execute(function() { r(a, window) });
})(function(r, h) {
    r.when("A").register("myModule_utils", function(A) {
        return { helper: function(x) { return x + 1; } };
    });
});
/* ******** */
(function(r) {
    var h = window.AmazonUIPageJS || window.P;
    var e = h._namespace || h.attributeErrors;
    var a = e ? e("MyAssets", "") : h;
    a.guardFatal ? a.guardFatal(r)(a, window) : a.execute(function() { r(a, window) });
})(function(r, h) {
    r.when("A", "myModule_utils").register("myModule_main", function(A, utils) {
        return { run: function() { return utils.helper(42); } };
    });
});
