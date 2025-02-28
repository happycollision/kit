import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { EventEmitter } from 'events';
import CheapWatch from 'cheap-watch';
import amp_validator from 'amphtml-validator';
import vite from 'vite';
import colors from 'kleur';
import create_manifest_data from '../../core/create_manifest_data/index.js';
import { create_app } from '../../core/create_app/index.js';
import { rimraf } from '../filesystem/index.js';
import { respond } from '../../runtime/server/index.js';
import { getRawBody } from '../node/index.js';
import { copy_assets, get_no_external, resolve_entry } from '../utils.js';
import { deep_merge, print_config_conflicts } from '../config/index.js';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { get_server } from '../server/index.js';
import { __fetch_polyfill } from '../../install-fetch.js';
import { SVELTE_KIT } from '../constants.js';

/** @typedef {{ cwd?: string, port: number, host?: string, https: boolean, config: import('types/config').ValidatedConfig }} Options */
/** @typedef {import('types/internal').SSRComponent} SSRComponent */

/** @param {Options} opts */
export function dev(opts) {
	__fetch_polyfill();

	return new Watcher(opts).init();
}

class Watcher extends EventEmitter {
	/** @param {Options} opts */
	constructor({ cwd = process.cwd(), port, host, https, config }) {
		super();

		/** @type {string} */
		this.cwd = cwd;

		/** @type {string} */
		this.dir = path.resolve(cwd, `${SVELTE_KIT}/dev`);

		this.port = port;
		this.host = host;
		this.https = https;

		/** @type {import('types/config').ValidatedConfig} */
		this.config = config;

		/**
		 * @type {vite.ViteDevServer | undefined}
		 */
		this.vite;

		process.on('exit', () => {
			this.close();
		});
	}

	async init() {
		rimraf(this.dir);
		copy_assets(this.dir);
		process.env.VITE_SVELTEKIT_AMP = this.config.kit.amp ? 'true' : '';

		await this.init_filewatcher();
		this.update();

		await this.init_server();

		return this;
	}

	async init_filewatcher() {
		this.cheapwatch = new CheapWatch({
			dir: this.config.kit.files.routes,
			/** @type {({ path }: { path: string }) => boolean} */
			filter: ({ path }) => path.split('/').every((part) => part[0] !== '_' || part[1] === '_')
		});

		await this.cheapwatch.init();

		// not sure why TS doesn't understand that CheapWatch extends EventEmitter
		this.cheapwatch.on('+', ({ isNew }) => {
			if (isNew) this.update();
		});

		this.cheapwatch.on('-', () => {
			this.update();
		});
	}

	async init_server() {
		if (!this.manifest) throw new Error('Must call init() before init_server()');

		/** @type {any} */
		const user_config = (this.config.kit.vite && this.config.kit.vite()) || {};

		const default_config = {
			server: {
				fs: {
					strict: true
				}
			}
		};

		/** @type {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => void} */
		let handler = (req, res) => {};

		this.server = await get_server(this.https, user_config, (req, res) => handler(req, res));

		const alias = user_config.resolve && user_config.resolve.alias;

		// don't warn on overriding defaults
		const [modified_user_config] = deep_merge(default_config, user_config);

		/** @type {[any, string[]]} */
		const [merged_config, conflicts] = deep_merge(modified_user_config, {
			configFile: false,
			root: this.cwd,
			resolve: {
				alias: Array.isArray(alias)
					? [
							{
								find: '$app',
								replacement: path.resolve(`${this.dir}/runtime/app`)
							},
							{
								find: '$lib',
								replacement: this.config.kit.files.lib
							}
					  ]
					: {
							$app: path.resolve(`${this.dir}/runtime/app`),
							$lib: this.config.kit.files.lib
					  }
			},
			plugins: [
				svelte({
					extensions: this.config.extensions,
					emitCss: !this.config.kit.amp
				})
			],
			publicDir: this.config.kit.files.assets,
			server: {
				middlewareMode: true,
				hmr: {
					...(this.https ? { server: this.server, port: this.port } : {})
				}
			},
			optimizeDeps: {
				entries: []
			},
			ssr: {
				noExternal: get_no_external(this.cwd, user_config.ssr && user_config.ssr.noExternal)
			}
		});

		print_config_conflicts(conflicts, 'kit.vite.');

		this.vite = await vite.createServer(merged_config);

		handler = await create_handler(this.vite, this.config, this.dir, this.cwd, this.manifest);

		this.server.listen(this.port, this.host || '0.0.0.0');
	}

	update() {
		const manifest_data = create_manifest_data({
			config: this.config,
			output: this.dir,
			cwd: this.cwd
		});

		create_app({
			manifest_data,
			output: this.dir,
			cwd: this.cwd
		});

		/** @type {import('types/internal').SSRManifest} */
		this.manifest = {
			assets: manifest_data.assets,
			layout: manifest_data.layout,
			error: manifest_data.error,
			routes: manifest_data.routes.map((route) => {
				if (route.type === 'page') {
					return {
						type: 'page',
						pattern: route.pattern,
						params: get_params(route.params),
						a: route.a,
						b: route.b
					};
				}

				return {
					type: 'endpoint',
					pattern: route.pattern,
					params: get_params(route.params),
					load: async () => {
						if (!this.vite) throw new Error('Vite server has not been initialized');
						const url = path.resolve(this.cwd, route.file);
						return await this.vite.ssrLoadModule(url);
					}
				};
			})
		};
	}

	close() {
		if (!this.vite || !this.server || !this.cheapwatch) {
			throw new Error('Cannot close server before it is initialized');
		}

		if (this.closed) return;
		this.closed = true;

		this.vite.close();
		this.server.close();
		this.cheapwatch.close();
	}
}

/** @param {string[]} array */
function get_params(array) {
	// given an array of params like `['x', 'y', 'z']` for
	// src/routes/[x]/[y]/[z]/svelte, create a function
	// that turns a RegExpExecArray into ({ x, y, z })

	/** @param {RegExpExecArray} match */
	const fn = (match) => {
		/** @type {Record<string, string>} */
		const params = {};
		array.forEach((key, i) => {
			if (key.startsWith('...')) {
				params[key.slice(3)] = decodeURIComponent(match[i + 1] || '');
			} else {
				params[key] = decodeURIComponent(match[i + 1]);
			}
		});
		return params;
	};

	return fn;
}

/**
 * @param {vite.ViteDevServer} vite
 * @param {import('types/config').ValidatedConfig} config
 * @param {string} dir
 * @param {string} cwd
 * @param {import('types/internal').SSRManifest} manifest
 */
async function create_handler(vite, config, dir, cwd, manifest) {
	/**
	 * @type {amp_validator.Validator?}
	 */
	const validator = config.kit.amp ? await amp_validator.getInstance() : null;

	/**
	 * @param {import('vite').ModuleNode} node
	 * @param {Set<import('vite').ModuleNode>} deps
	 */
	const find_deps = (node, deps) => {
		for (const dep of node.importedModules) {
			if (!deps.has(dep)) {
				deps.add(dep);
				find_deps(dep, deps);
			}
		}
	};

	/**
	 * @param {import("http").IncomingMessage} req
	 * @param {import("http").ServerResponse} res
	 */
	return (req, res) => {
		vite.middlewares(req, res, async () => {
			try {
				if (!req.url || !req.method) throw new Error('Incomplete request');
				const parsed = new URL(req.url, 'http://localhost/');

				if (req.url === '/favicon.ico') return;

				/** @type {Partial<import('types/internal').Hooks>} */
				const hooks = resolve_entry(config.kit.files.hooks)
					? await vite.ssrLoadModule(`/${config.kit.files.hooks}`)
					: {};

				if (/** @type {any} */ (hooks).getContext) {
					// TODO remove this for 1.0
					throw new Error(
						'The getContext hook has been removed. See https://kit.svelte.dev/docs#hooks'
					);
				}

				const root = (await vite.ssrLoadModule(`/${dir}/generated/root.svelte`)).default;

				let body;

				try {
					body = await getRawBody(req);
				} catch (err) {
					res.statusCode = err.status || 400;
					return res.end(err.reason || 'Invalid request body');
				}

				const host = /** @type {string} */ (config.kit.host ||
					req.headers[config.kit.hostHeader || 'host']);

				const rendered = await respond(
					{
						headers: /** @type {import('types/helper').Headers} */ (req.headers),
						method: req.method,
						host,
						path: parsed.pathname,
						query: parsed.searchParams,
						rawBody: body
					},
					{
						amp: config.kit.amp,
						dev: true,
						entry: {
							file: `/${SVELTE_KIT}/dev/runtime/internal/start.js`,
							css: [],
							js: []
						},
						floc: config.kit.floc,
						get_stack: (error) => {
							vite.ssrFixStacktrace(error);
							return error.stack;
						},
						handle_error: /** @param {Error & {frame?: string}} error */ (error) => {
							vite.ssrFixStacktrace(error);
							console.error(colors.bold().red(error.message));
							if (error.frame) {
								console.error(colors.gray(error.frame));
							}
							if (error.stack) {
								console.error(colors.gray(error.stack));
							}
						},
						hooks: {
							getSession: hooks.getSession || (() => ({})),
							handle: hooks.handle || (({ request, resolve }) => resolve(request)),
							serverFetch: hooks.serverFetch || fetch
						},
						hydrate: config.kit.hydrate,
						paths: config.kit.paths,
						load_component: async (id) => {
							const url = path.resolve(cwd, id);

							const module = /** @type {SSRComponent} */ (await vite.ssrLoadModule(url));
							const node = await vite.moduleGraph.getModuleByUrl(url);

							if (!node) throw new Error(`Could not find node for ${url}`);

							const deps = new Set();
							find_deps(node, deps);

							const styles = new Set();

							for (const dep of deps) {
								const parsed = new URL(dep.url, 'http://localhost/');
								const query = parsed.searchParams;

								// TODO what about .scss files, etc?
								if (
									dep.file.endsWith('.css') ||
									(query.has('svelte') && query.get('type') === 'style')
								) {
									try {
										const mod = await vite.ssrLoadModule(dep.url);
										styles.add(mod.default);
									} catch {
										// this can happen with dynamically imported modules, I think
										// because the Vite module graph doesn't distinguish between
										// static and dynamic imports? TODO investigate, submit fix
									}
								}
							}

							let entry = `/${id}`;
							if (!entry.endsWith('.svelte')) {
								entry += '?import';
							}
							return {
								module,
								entry,
								css: [],
								js: [],
								styles: Array.from(styles)
							};
						},
						manifest,
						read: (file) => fs.readFileSync(path.join(config.kit.files.assets, file)),
						root,
						router: config.kit.router,
						ssr: config.kit.ssr,
						target: config.kit.target,
						template: ({ head, body }) => {
							let rendered = fs
								.readFileSync(config.kit.files.template, 'utf8')
								.replace('%svelte.head%', () => head)
								.replace('%svelte.body%', () => body);

							if (config.kit.amp && validator) {
								const result = validator.validateString(rendered);

								if (result.status !== 'PASS') {
									const lines = rendered.split('\n');

									/** @param {string} str */
									const escape = (str) =>
										str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

									rendered = `<!doctype html>
										<head>
											<meta charset="utf-8" />
											<meta name="viewport" content="width=device-width, initial-scale=1" />
											<style>
												body {
													font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
													color: #333;
												}

												pre {
													background: #f4f4f4;
													padding: 1em;
													overflow-x: auto;
												}
											</style>
										</head>
										<h1>AMP validation failed</h1>

										${result.errors
											.map(
												(error) => `
											<h2>${error.severity}</h2>
											<p>Line ${error.line}, column ${error.col}: ${error.message} (<a href="${error.specUrl}">${
													error.code
												}</a>)</p>
											<pre>${escape(lines[error.line - 1])}</pre>
										`
											)
											.join('\n\n')}
									`;
								}
							}

							return rendered;
						},
						trailing_slash: config.kit.trailingSlash
					}
				);

				if (rendered) {
					res.writeHead(rendered.status, rendered.headers);
					if (rendered.body) res.write(rendered.body);
					res.end();
				} else {
					res.statusCode = 404;
					res.end('Not found');
				}
			} catch (e) {
				vite.ssrFixStacktrace(e);
				res.statusCode = 500;
				res.end(e.stack);
			}
		});
	};
}
