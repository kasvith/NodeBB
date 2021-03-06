'use strict';

var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var winston = require('winston');
var async = require('async');
var path = require('path');
var fs = require('fs');
var nconf = require('nconf');
var _ = require('lodash');

var plugins = require('../plugins');
var file = require('../file');

var viewsPath = nconf.get('views_dir');

var Templates = module.exports;

function processImports(paths, templatePath, source, callback) {
	var regex = /<!-- IMPORT (.+?) -->/;

	var matches = source.match(regex);

	if (!matches) {
		return callback(null, source);
	}

	var partial = matches[1];
	if (paths[partial] && templatePath !== partial) {
		fs.readFile(paths[partial], 'utf8', function (err, partialSource) {
			if (err) {
				return callback(err);
			}

			source = source.replace(regex, partialSource);
			processImports(paths, templatePath, source, callback);
		});
	} else {
		winston.warn('[meta/templates] Partial not loaded: ' + matches[1]);
		source = source.replace(regex, '');

		processImports(paths, templatePath, source, callback);
	}
}
Templates.processImports = processImports;

function getTemplateDirs(callback) {
	var pluginTemplates = _.values(plugins.pluginsData)
		.filter(function (pluginData) {
			return !pluginData.id.startsWith('nodebb-theme-');
		})
		.map(function (pluginData) {
			return path.join(__dirname, '../../node_modules/', pluginData.id, pluginData.templates || 'templates');
		});

	var themeConfig = require(nconf.get('theme_config'));
	var theme = themeConfig.baseTheme;

	var themePath;
	var themeTemplates = [nconf.get('theme_templates_path')];
	while (theme) {
		themePath = path.join(nconf.get('themes_path'), theme);
		themeConfig = require(path.join(themePath, 'theme.json'));

		themeTemplates.push(path.join(themePath, themeConfig.templates || 'templates'));
		theme = themeConfig.baseTheme;
	}

	themeTemplates.push(nconf.get('base_templates_path'));
	themeTemplates = _.uniq(themeTemplates.reverse());

	var coreTemplatesPath = nconf.get('core_templates_path');

	var templateDirs = _.uniq([coreTemplatesPath].concat(themeTemplates, pluginTemplates));

	async.filter(templateDirs, file.exists, callback);
}

function getTemplateFiles(dirs, callback) {
	async.waterfall([
		function (cb) {
			async.map(dirs, function (dir, next) {
				file.walk(dir, function (err, files) {
					if (err) { return next(err); }

					files = files.filter(function (path) {
						return path.endsWith('.tpl');
					}).map(function (file) {
						return {
							name: path.relative(dir, file).replace(/\\/g, '/'),
							path: file,
						};
					});
					next(null, files);
				});
			}, cb);
		},
		function (buckets, cb) {
			var dict = {};
			buckets.forEach(function (files) {
				files.forEach(function (file) {
					dict[file.name] = file.path;
				});
			});

			cb(null, dict);
		},
	], callback);
}

function compile(callback) {
	callback = callback || function () {};

	async.waterfall([
		function (next) {
			rimraf(viewsPath, function (err) { next(err); });
		},
		function (next) {
			mkdirp(viewsPath, function (err) { next(err); });
		},
		getTemplateDirs,
		getTemplateFiles,
		function (files, next) {
			async.each(Object.keys(files), function (name, next) {
				var filePath = files[name];

				async.waterfall([
					function (next) {
						fs.readFile(filePath, 'utf8', next);
					},
					function (source, next) {
						processImports(files, name, source, next);
					},
					function (source, next) {
						mkdirp(path.join(viewsPath, path.dirname(name)), function (err) {
							next(err, source);
						});
					},
					function (compiled, next) {
						fs.writeFile(path.join(viewsPath, name), compiled, next);
					},
				], next);
			}, next);
		},
		function (next) {
			winston.verbose('[meta/templates] Successfully compiled templates.');
			next();
		},
	], callback);
}
Templates.compile = compile;
