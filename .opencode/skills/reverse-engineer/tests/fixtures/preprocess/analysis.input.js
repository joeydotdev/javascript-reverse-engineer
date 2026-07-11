!function() {
    "use strict";
    class EventEmitter {
        constructor() { this._handlers = new Map(); }
        on(name, fn) { this._handlers.set(name, fn); }
        emit(name, data) { var h = this._handlers.get(name); h && h(data); }
    }
    function createLogger(prefix) {
        return { log: function(msg) { console.log(prefix + ": " + msg); } };
    }
    window.MyLib = { EventEmitter: EventEmitter, createLogger: createLogger };
    window.MyLib.VERSION = "2.0.0";
}();
