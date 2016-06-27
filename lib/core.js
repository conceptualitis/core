'use strict';

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var fs = require('fs');
var gonzales = require('gonzales-pe');
var minimatch = require('minimatch');
var Errors = require('./errors');
var Plugin = require('./plugin');

var vow = require('vow');
var vfs = require('vow-fs');

var Comb = (function () {
  function Comb() {
    _classCallCheck(this, Comb);

    this.config = {};
    this.exclude = [];
    // Whether lint mode is on.
    this.lint = false;
    // List of file paths that should be excluded from processing.
    this.pathsToExclude = null;
    // List of used plugins.
    this.plugins = [];
    this.pluginsDependencies = {};
    // List of supported syntaxes.
    this.supportedSyntaxes = new Set();
    // Syntax override
    this.syntaxOverride = false;
    // Whether verbose mode is on.
    this.verbose = false;
  }

  Comb.prototype.configure = function configure(config) {
    if (typeof config !== 'object')
      // TODO: throw error
      throw new Error();

    this.lint = config.lint;
    this.verbose = config.verbose;
    this.syntaxOverride = config.syntax;
    if (config.exclude) this.exclude = config.exclude.map(function (pattern) {
      return new minimatch.Minimatch(pattern);
    });

    for (var i = 0, l = this.plugins.length; i < l; i++) {
      var plugin = this.plugins[i];
      var _name = plugin.name;
      if (!config.hasOwnProperty(_name)) continue;

      try {
        plugin.value = config[_name];
        this.config[_name] = plugin.value;
      } catch (e) {
        // TODO: throw error
      }
    }

    // Chaining.
    return this;
  };

  /**
   * @param {String} path
   * @returns {Promise}
   */

  Comb.prototype.lintDirectory = function lintDirectory(path) {
    var _this = this;

    var files = this._getAcceptableFilesFromDirectory(path);
    var promises = files.map(function (file) {
      return _this.lintFile(file);
    });
    return Promise.all(promises);
  };

  /**
   * @param {String} path
   * @returns {Promise}
   */

  Comb.prototype.lintFile = function lintFile(path) {
    var _this2 = this;

    var syntax = path.split('.').pop();
    return this._readFile(path).then(function (string) {
      return _this2.lintString(string, { syntax: syntax, filename: path });
    });
  };

  /**
   * @param {String} path
   */

  Comb.prototype.lintPath = function lintPath(path) {
    path = path.replace(/\/$/, '');
    return fs.statSync(path).isDirectory() ? this.lintDirectory(path) : this.lintFile(path);
  };

  /**
   * @param {String} text
   * @param {{context: String, filename: String, syntax: String}} options
   * @returns {Promise} Resolves with <Array> list of found errors.
   */

  Comb.prototype.lintString = function lintString(text, options) {
    return this._parseString(text, options).then(this._lintTree.bind(this));
  };

  /**
   * Processes directory recursively.
   *
   * @param {String} path
   * @returns {Promise}
   */

  Comb.prototype.processDirectory = function processDirectory(path) {
    var that = this;

    return vfs.listDir(path).then(function (filenames) {
      return vow.all(filenames.map(function (filename) {
        var fullname = path + '/' + filename;
        return vfs.stat(fullname).then(function (stat) {
          if (stat.isDirectory() && that._shouldProcess(fullname)) {
            return that.processDirectory(fullname);
          } else {
            return that.processFile(fullname);
          }
        });
      })).then(function (results) {
        return [].concat.apply([], results);
      });
    });
  };

  /**
   * Processes single file.
   *
   * @param {String} path
   * @returns {Promise}
   */

  Comb.prototype.processFile = function processFile(path) {
    var that = this;

    if (!this._shouldProcessFile(path)) return;

    return vfs.read(path, 'utf8').then(function (data) {
      var syntax = that.syntaxOverride || path.split('.').pop();
      var processedData = that.processString(data, {
        syntax: syntax,
        filename: path
      });

      if (that.lint) return processedData;

      if (data === processedData) {
        if (that.verbose) console.log(' ', path);
        return 0;
      }

      return vfs.write(path, processedData, 'utf8').then(function () {
        if (that.verbose) console.log('✓', path);
        return 1;
      });
    });
  };

  /**
   * Processes directory or file.
   *
   * @returns {Promise}
   */

  Comb.prototype.processPath = function processPath(path) {
    var that = this;
    path = path.replace(/\/$/, '');

    return vfs.stat(path).then(function (stat) {
      if (stat.isDirectory()) {
        return that.processDirectory(path);
      } else {
        return that.processFile(path);
      }
    });
  };

  /**
   * Processes a string.
   *
   * @param {String} text
   * @param {{context: String, filename: String, syntax: String}} options
   * @returns {String} Processed string
   */

  Comb.prototype.processString = function processString(text, options) {
    return this._parseString(text, options).then(this._processTree.bind(this)).then(function (ast) {
      return ast.toString();
    });
  };

  /**
   * Add a plugin.
   * @param {Object} options
   * @return {Comb}
   */

  Comb.prototype.use = function use(options) {
    // Check whether plugin with the same is already used.
    var pluginName = options.name;
    if (this._pluginAlreadyUsed(pluginName)) {
      if (this.verbose) console.warn(Errors.twoPluginsWithSameName(pluginName));
      return;
    }

    var plugin = new Plugin(options);

    plugin.syntax.forEach(function (s) {
      this.supportedSyntaxes.add(s);
    }, this);

    // Sort plugins.
    var pluginToRunBefore = plugin.runBefore;

    if (!pluginToRunBefore) {
      this.plugins.push(plugin);
    } else {
      if (this._pluginAlreadyUsed(pluginToRunBefore)) {
        var i = this._pluginIndex(pluginToRunBefore);
        this.plugins.splice(i, 0, plugin);
      } else {
        this.plugins.push(plugin);
        if (!this.pluginsDependencies[pluginToRunBefore]) this.pluginsDependencies[pluginToRunBefore] = [];
        this.pluginsDependencies[pluginToRunBefore].push(pluginName);
      }
    }

    var dependents = this.pluginsDependencies[pluginName];
    if (!dependents) return this;

    for (var i = 0, l = dependents.length; i < l; i++) {
      var _name2 = dependents[i];
      var x = this._pluginIndex(_name2);
      var _plugin = this.plugins[x];
      this.plugins.splice(x, 1);
      this.plugins.splice(-1, 0, _plugin);
    }

    // Chaining.
    return this;
  };

  Comb.prototype._getAcceptableFilesFromDirectory = function _getAcceptableFilesFromDirectory(path) {
    if (!this._shouldProcess(path)) return;

    var files = [];
    var filesInThisDir = fs.readdirSync(path);

    for (var i = 0, fl = filesInThisDir.length; i < fl; i++) {
      var fullname = path + '/' + filesInThisDir[i];
      var stat = fs.statSync(fullname);
      if (stat.isDirectory() && this._shouldProcess(fullname)) files = files.concat(this._getAcceptableFilesFromDirectory(fullname));else if (this._shouldProcessFile(fullname)) files.push(fullname);
    }

    return files;
  };

  /**
   * @param {Node} ast
   * @param {String=} filename
   * @return {Promise} Resolves with <Array> list of errors.
   */

  Comb.prototype._lintTree = function _lintTree(ast, filename) {
    var _this3 = this;

    var errors = [];
    var config = this.config;

    return new Promise(function (resolve) {
      _this3.plugins.filter(function (plugin) {
        return typeof plugin.value !== null && typeof plugin.lint === 'function' && plugin.syntax.indexOf(ast.syntax) !== -1;
      }).forEach(function (plugin) {
        var e = plugin.lint(ast, config);
        errors = errors.concat(e);
      });

      if (filename) {
        errors.map(function (error) {
          error.filename = filename;
          return error;
        });
      }

      resolve(errors);
    });
  };

  Comb.prototype._parseString = function _parseString(text, options) {
    var syntax = options && options.syntax;
    var filename = options && options.filename || '';
    var context = options && options.context;
    var tree = undefined;

    if (!text) return this.lint ? [] : text;

    if (!syntax) syntax = 'css';
    this.syntax = syntax;

    return new Promise(function (resolve) {
      try {
        tree = gonzales.parse(text, { syntax: syntax, rule: context });
        resolve(tree, filename);
      } catch (e) {
        var version = require('../package.json').version;
        var message = filename ? [filename] : [];
        message.push(e.message);
        message.push('CSScomb Core version: ' + version);
        e.stack = e.message = message.join('\n');
        throw e;
      }
    });
  };

  Comb.prototype._pluginAlreadyUsed = function _pluginAlreadyUsed(name) {
    return this._pluginIndex(name) !== -1;
  };

  Comb.prototype._pluginIndex = function _pluginIndex(name) {
    var index = -1;
    this.plugins.some(function (plugin, i) {
      if (plugin.name === name) {
        index = i;
        return true;
      }
    });
    return index;
  };

  /**
   * @param {Node} ast
   * @return {Node} Transformed AST
   */

  Comb.prototype._processTree = function _processTree(ast) {
    var _this4 = this;

    var config = this.config;

    return new Promise(function (resolve) {
      _this4.plugins.filter(function (plugin) {
        return plugin.value !== null && typeof plugin.process === 'function' && plugin.syntax.indexOf(ast.syntax) !== -1;
      }).forEach(function (plugin) {
        plugin.process(ast, config);
      });

      resolve(ast);
    });
  };

  Comb.prototype._readFile = function _readFile(path) {
    var _this5 = this;

    return new Promise(function (resolve, reject) {
      if (!_this5._shouldProcessFile(path)) reject();

      fs.readFile(path, 'utf8', function (e, string) {
        if (e) reject();
        resolve(string);
      });
    });
  };

  /**
   * Checks if path is not present in `exclude` list.
   *
   * @param {String} path
   * @returns {Boolean} False if specified path is present in `exclude` list.
   * Otherwise returns true.
   */

  Comb.prototype._shouldProcess = function _shouldProcess(path) {
    path = path.replace(/\/$/, '');
    if (!fs.existsSync(path)) {
      console.warn('Path ' + path + ' was not found.');
      return false;
    }

    path = path.replace(/^\.\//, '');
    return this.exclude.every(function (e) {
      return !e.match(path);
    });
  };

  /**
   * Checks if specified path is not present in `exclude` list and it has one of
   * acceptable extensions.
   *
   * @param {String} path
   * @returns {Boolean} False if the path either has unacceptable extension or
   * is present in `exclude` list. True if everything is ok.
   */

  Comb.prototype._shouldProcessFile = function _shouldProcessFile(path) {
    // Get file's extension:
    var syntax = path.split('.').pop();

    // Check if syntax is supported. If not, ignore the file:
    if (!this.supportedSyntaxes.has(syntax)) return false;

    return this._shouldProcess(path);
  };

  return Comb;
})();

module.exports = Comb;