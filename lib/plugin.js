const path = require('path');
const fs = require('fs');
const toposort = require('toposort');

const chunkOnlyConfig = {
  assets: true,
  cached: false,
  children: false,
  chunks: true,
  chunkModules: false,
  chunkOrigins: false,
  errorDetails: false,
  hash: false,
  modules: false,
  reasons: false,
  source: false,
  timings: false,
  version: false
};

const emitCountMap = new Map();

function ManifestPlugin(opts) {
  this.opts = Object.assign({
    publicPath: null,
    basePath: '',
    fileName: 'manifest.json',
    transformExtensions: /^(gz|map)$/i,
    writeToFileEmit: false,
    seed: null,
    filter: null,
    map: null,
    generate: null,
    sort: null,
    serialize: function (manifest) {
      return JSON.stringify(manifest, null, 2);
    },
  }, opts);
}

const getFileType = str => {
  str = str.replace(/\?.*/, '');
  var split = str.split('.');
  return split[split.length - 1];
};

ManifestPlugin.prototype.apply = function (compiler) {
  const moduleAssets = {};

  const outputFolder = compiler.options.output.path;
  const outputFile = path.resolve(outputFolder, this.opts.fileName);
  const outputName = path.relative(outputFolder, outputFile);

  const moduleAsset = (module, file) => {
    if (module.userRequest) {
      moduleAssets[file] = path.join(
        path.dirname(file),
        path.basename(module.userRequest)
      );
    }
  };

  const emit = (compilation, compileCallback) => {
    const emitCount = emitCountMap.get(outputFile) - 1
    emitCountMap.set(outputFile, emitCount);

    let manifest = this.opts.seed || {};

    const publicPath = this.opts.publicPath != null ? this.opts.publicPath : compilation.options.output.publicPath;
    const stats = compilation.getStats().toJson(chunkOnlyConfig);

    const chunks = compilation.getStats().toJson(chunkOnlyConfig).chunks
      .filter(c => { // https://github.com/jantimon/html-webpack-plugin/blob/master/index.js#L374
        if (!c.names[0]) return false;
        if (!c.initial || typeof c.isInitial === 'function' && !c.isInitial() || typeof c.isOnlyInitial === 'function' && !c.isOnlyInitial()) {
          return false;
        }
        return true;
      });

    const nodeMap = chunks.reduce((m, c) => m.set(c.id, c), new Map());

    const edges = compilation.chunkGroups.reduce((result, chunkGroup) => result.concat(
      Array.from(chunkGroup.parentsIterable, parentGroup => [parentGroup, chunkGroup])
    ), []);

    const sortedGroups = toposort.array(compilation.chunkGroups, edges);

    const sortedChunks = sortedGroups
      .reduce((result, chunkGroup) => result.concat(chunkGroup.chunks), [])
      .map(c => nodeMap.get(c.id))
      .filter(x => x)

    const files = new Map();

    sortedChunks.forEach(chunk => {
      chunk.files.forEach(path => {
        const name = chunk.names[0] ? chunk.names[0] + '.' + getFileType(path) : path; // For nameless chunks, just map the files directly.
        files.set(name, {
          path,
          chunk,
          name
        })
      })
    });

    // module assets don't show up in assetsByChunkName.
    // we're getting them this way;
    stats.assets.forEach(asset => {
      var name = moduleAssets[asset.name];
      if (name) {
        return files.set(name, {
          path: asset.name,
          name,
          isModuleAsset: true
        });
      }

      var isEntryAsset = asset.chunks.length > 0;
      if (isEntryAsset) {
        return files;
      }

      return files.set(name, {
        path: asset.name,
        name: asset.name
      });
    });

    // Append optional basepath onto all references.
    // This allows output path to be reflected in the manifest.
    if (this.opts.basePath) {
      files.forEach(file => {
        file.name = this.opts.basePath + file.name;
      });
    }

    if (publicPath) {
      // Similar to basePath but only affects the value (similar to how
      // output.publicPath turns require('foo/bar') into '/public/foo/bar', see
      // https://github.com/webpack/docs/wiki/configuration#outputpublicpath
      files.forEach(file => {
        file.path = publicPath + file.path;
      });
    }

    files.forEach(file => {
      file.name = file.name.replace(/\\/g, '/');
      file.path = file.path.replace(/\\/g, '/');
    });

    if (this.opts.generate) {
      manifest = this.opts.generate(manifest, files, compilation);
    } else {
      files.forEach(file => {
        if (file.path.includes('hot-update')) return;
        if (emitCountMap.get(path.join(outputFolder, file.name)) !== undefined) return;
        // Don't add manifest from another instance

        manifest[file.name] = file.path;
      })
    }

    const isLastEmit = emitCount === 0
    if (isLastEmit) {
      var output = this.opts.serialize(manifest);

      compilation.assets[outputName] = {
        source: () => output,
        size: () => output.length
      };

      if (this.opts.writeToFileEmit) {
        fs.writeFileSync(outputFile, output);
      }
    }

    if (compiler.hooks) {
      compiler.hooks.webpackManifestPluginAfterEmit.call(manifest);
    } else {
      compilation.applyPluginsAsync('webpack-manifest-plugin-after-emit', manifest, compileCallback);
    }
  };

  function beforeRun(compiler, callback) {
    let emitCount = emitCountMap.get(outputFile) || 0;
    emitCountMap.set(outputFile, emitCount + 1);

    if (callback) {
      callback();
    }
  }

  if (compiler.hooks) {
    const SyncWaterfallHook = require('tapable').SyncWaterfallHook;
    const pluginOptions = {
      name: 'ManifestPlugin',
      stage: Infinity
    };
    compiler.hooks.webpackManifestPluginAfterEmit = new SyncWaterfallHook(['manifest']);

    compiler.hooks.compilation.tap(pluginOptions, compilation => {
      compilation.hooks.moduleAsset.tap(pluginOptions, moduleAsset);
    });
    compiler.hooks.emit.tap(pluginOptions, emit);

    compiler.hooks.run.tap(pluginOptions, beforeRun);
    compiler.hooks.watchRun.tap(pluginOptions, beforeRun);
  } else {
    compiler.plugin('compilation', compilation => {
      compilation.plugin('module-asset', moduleAsset);
    });
    compiler.plugin('emit', emit);

    compiler.plugin('before-run', beforeRun);
    compiler.plugin('watch-run', beforeRun);
  }
};

module.exports = ManifestPlugin;
