/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import { APP_BASE_HREF, PlatformLocation } from '@angular/common';
import {
  ApplicationRef,
  Compiler,
  Injector,
  createPlatformFactory,
  platformCore,
  runInInjectionContext,
  ɵwhenStable as whenStable,
  ɵConsole,
} from '@angular/core';
import {
  INITIAL_CONFIG,
  ɵINTERNAL_SERVER_PLATFORM_PROVIDERS as INTERNAL_SERVER_PLATFORM_PROVIDERS,
} from '@angular/platform-server';
import { Route, Router, ɵloadChildren as loadChildrenHelper } from '@angular/router';
import { ServerAssets } from '../assets';
import { Console } from '../console';
import { AngularAppManifest, getAngularAppManifest } from '../manifest';
import { AngularBootstrap, isNgModule } from '../utils/ng';
import { joinUrlParts } from '../utils/url';
import { PrerenderFallback, RenderMode, SERVER_ROUTES_CONFIG, ServerRoute } from './route-config';
import { RouteTree, RouteTreeNodeMetadata } from './route-tree';

/**
 * Regular expression to match segments preceded by a colon in a string.
 */
const URL_PARAMETER_REGEXP = /(?<!\\):([^/]+)/g;

/**
 * An set of HTTP status codes that are considered valid for redirect responses.
 */
const VALID_REDIRECT_RESPONSE_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Additional metadata for a server configuration route tree.
 */
type ServerConfigRouteTreeAdditionalMetadata = Partial<ServerRoute>;

/**
 * Metadata for a server configuration route tree node.
 */
type ServerConfigRouteTreeNodeMetadata = RouteTreeNodeMetadata &
  ServerConfigRouteTreeAdditionalMetadata;

/**
 * Result of extracting routes from an Angular application.
 */
interface AngularRouterConfigResult {
  /**
   * The base URL for the application.
   * This is the base href that is used for resolving relative paths within the application.
   */
  baseHref: string;

  /**
   * An array of `RouteTreeNodeMetadata` objects representing the application's routes.
   *
   * Each `RouteTreeNodeMetadata` contains details about a specific route, such as its path and any
   * associated redirection targets. This array is asynchronously generated and
   * provides information on how routes are structured and resolved.
   */
  routes: RouteTreeNodeMetadata[];

  /**
   * Optional configuration for server routes.
   *
   * This property allows you to specify an array of server routes for configuration.
   * If not provided, the default configuration or behavior will be used.
   */
  serverRoutesConfig?: ServerRoute[] | null;
}

/**
 * Traverses an array of route configurations to generate route tree node metadata.
 *
 * This function processes each route and its children, handling redirects, SSG (Static Site Generation) settings,
 * and lazy-loaded routes. It yields route metadata for each route and its potential variants.
 *
 * @param options - The configuration options for traversing routes.
 * @returns An async iterable iterator of route tree node metadata.
 */
export async function* traverseRoutesConfig({
  routes,
  compiler,
  parentInjector,
  parentRoute,
  serverConfigRouteTree,
  invokeGetPrerenderParams,
}: {
  routes: Route[];
  compiler: Compiler;
  parentInjector: Injector;
  parentRoute: string;
  serverConfigRouteTree: RouteTree<ServerConfigRouteTreeAdditionalMetadata> | undefined;
  invokeGetPrerenderParams: boolean;
}): AsyncIterableIterator<RouteTreeNodeMetadata> {
  for (const route of routes) {
    const { path = '', redirectTo, loadChildren, children } = route;
    const currentRoutePath = joinUrlParts(parentRoute, path);

    // Get route metadata from the server config route tree, if available
    const metadata: ServerConfigRouteTreeNodeMetadata = {
      ...(serverConfigRouteTree
        ? getMatchedRouteMetadata(serverConfigRouteTree, currentRoutePath)
        : undefined),
      route: currentRoutePath,
    };

    // Handle redirects
    if (typeof redirectTo === 'string') {
      const redirectToResolved = resolveRedirectTo(currentRoutePath, redirectTo);
      if (metadata.status && !VALID_REDIRECT_RESPONSE_CODES.has(metadata.status)) {
        throw new Error(
          `The '${metadata.status}' status code is not a valid redirect response code. ` +
            `Please use one of the following redirect response codes: ${[...VALID_REDIRECT_RESPONSE_CODES.values()].join(', ')}.`,
        );
      }
      yield { ...metadata, redirectTo: redirectToResolved };
    } else if (metadata.renderMode === RenderMode.Prerender) {
      // Handle SSG routes
      yield* handleSSGRoute(metadata, parentInjector, invokeGetPrerenderParams);
    } else {
      yield metadata;
    }

    // Recursively process child routes
    if (children?.length) {
      yield* traverseRoutesConfig({
        routes: children,
        compiler,
        parentInjector,
        parentRoute: currentRoutePath,
        serverConfigRouteTree,
        invokeGetPrerenderParams,
      });
    }

    // Load and process lazy-loaded child routes
    if (loadChildren) {
      const loadedChildRoutes = await loadChildrenHelper(
        route,
        compiler,
        parentInjector,
      ).toPromise();

      if (loadedChildRoutes) {
        const { routes: childRoutes, injector = parentInjector } = loadedChildRoutes;
        yield* traverseRoutesConfig({
          routes: childRoutes,
          compiler,
          parentInjector: injector,
          parentRoute: currentRoutePath,
          serverConfigRouteTree,
          invokeGetPrerenderParams,
        });
      }
    }
  }
}

/**
 * Retrieves the matched route metadata from the server configuration route tree.
 *
 * @param serverConfigRouteTree - The server configuration route tree.
 * @param currentRoutePath - The current route path being processed.
 * @returns The metadata associated with the matched route.
 */
function getMatchedRouteMetadata(
  serverConfigRouteTree: RouteTree<ServerConfigRouteTreeAdditionalMetadata>,
  currentRoutePath: string,
): ServerConfigRouteTreeNodeMetadata {
  const metadata = serverConfigRouteTree.match(currentRoutePath);

  if (!metadata) {
    throw new Error(
      `The '${currentRoutePath}' route does not match any route defined in the server routing configuration. ` +
        'Please ensure this route is added to the server routing configuration.',
    );
  }

  return metadata;
}

/**
 * Handles SSG (Static Site Generation) routes by invoking `getPrerenderParams` and yielding
 * all parameterized paths.
 *
 * @param metadata - The metadata associated with the route tree node.
 * @param parentInjector - The dependency injection container for the parent route.
 * @param invokeGetPrerenderParams - A flag indicating whether to invoke the `getPrerenderParams` function.
 * @returns An async iterable iterator that yields route tree node metadata for each SSG path.
 */
async function* handleSSGRoute(
  metadata: ServerConfigRouteTreeNodeMetadata,
  parentInjector: Injector,
  invokeGetPrerenderParams: boolean,
): AsyncIterableIterator<RouteTreeNodeMetadata> {
  if (metadata.renderMode !== RenderMode.Prerender) {
    throw new Error(
      `'handleSSGRoute' was called for a route which rendering mode is not prerender.`,
    );
  }

  const { route: currentRoutePath, fallback, ...meta } = metadata;
  const getPrerenderParams = 'getPrerenderParams' in meta ? meta.getPrerenderParams : undefined;

  if ('getPrerenderParams' in meta) {
    delete meta['getPrerenderParams'];
  }

  if (invokeGetPrerenderParams && URL_PARAMETER_REGEXP.test(currentRoutePath)) {
    if (!getPrerenderParams) {
      throw new Error(
        `The '${currentRoutePath}' route uses prerendering and includes parameters, but 'getPrerenderParams' is missing. ` +
          `Please define 'getPrerenderParams' function for this route in your server routing configuration ` +
          `or specify a different 'renderMode'.`,
      );
    }

    const parameters = await runInInjectionContext(parentInjector, () => getPrerenderParams());

    for (const params of parameters) {
      const routeWithResolvedParams = currentRoutePath.replace(URL_PARAMETER_REGEXP, (match) => {
        const parameterName = match.slice(1);
        const value = params[parameterName];
        if (typeof value !== 'string') {
          throw new Error(
            `The 'getPrerenderParams' function defined for the '${currentRoutePath}' route ` +
              `returned a non-string value for parameter '${parameterName}'. ` +
              `Please make sure the 'getPrerenderParams' function returns values for all parameters ` +
              'specified in this route.',
          );
        }

        return value;
      });

      yield { ...meta, route: routeWithResolvedParams };
    }
  }

  // Handle fallback render modes
  if (fallback !== PrerenderFallback.None || !invokeGetPrerenderParams) {
    yield {
      ...meta,
      route: currentRoutePath,
      renderMode: fallback === PrerenderFallback.Client ? RenderMode.Client : RenderMode.Server,
    };
  }
}

/**
 * Resolves the `redirectTo` property for a given route.
 *
 * This function processes the `redirectTo` property to ensure that it correctly
 * resolves relative to the current route path. If `redirectTo` is an absolute path,
 * it is returned as is. If it is a relative path, it is resolved based on the current route path.
 *
 * @param routePath - The current route path.
 * @param redirectTo - The target path for redirection.
 * @returns The resolved redirect path as a string.
 */
function resolveRedirectTo(routePath: string, redirectTo: string): string {
  if (redirectTo[0] === '/') {
    // If the redirectTo path is absolute, return it as is.
    return redirectTo;
  }

  // Resolve relative redirectTo based on the current route path.
  const segments = routePath.split('/');
  segments.pop(); // Remove the last segment to make it relative.

  return joinUrlParts(...segments, redirectTo);
}

/**
 * Builds a server configuration route tree from the given server routes configuration.
 *
 * @param serverRoutesConfig - The array of server routes to be used for configuration.
 * @returns A `RouteTree` populated with the server routes and their metadata.
 */
function buildServerConfigRouteTree(
  serverRoutesConfig: ServerRoute[],
): RouteTree<ServerConfigRouteTreeAdditionalMetadata> {
  const serverConfigRouteTree = new RouteTree<ServerConfigRouteTreeAdditionalMetadata>();
  for (const { path, ...metadata } of serverRoutesConfig) {
    serverConfigRouteTree.insert(path, metadata);
  }

  return serverConfigRouteTree;
}

/**
 * Retrieves routes from the given Angular application.
 *
 * This function initializes an Angular platform, bootstraps the application or module,
 * and retrieves routes from the Angular router configuration. It handles both module-based
 * and function-based bootstrapping. It yields the resulting routes as `RouteTreeNodeMetadata` objects.
 *
 * @param bootstrap - A function that returns a promise resolving to an `ApplicationRef` or an Angular module to bootstrap.
 * @param document - The initial HTML document used for server-side rendering.
 * This document is necessary to render the application on the server.
 * @param url - The URL for server-side rendering. The URL is used to configure `ServerPlatformLocation`. This configuration is crucial
 * for ensuring that API requests for relative paths succeed, which is essential for accurate route extraction.
 * @param invokeGetPrerenderParams - A boolean flag indicating whether to invoke `getPrerenderParams` for parameterized SSG routes
 * to handle prerendering paths. Defaults to `false`.
 * See:
 *  - https://github.com/angular/angular/blob/d608b857c689d17a7ffa33bbb510301014d24a17/packages/platform-server/src/location.ts#L51
 *  - https://github.com/angular/angular/blob/6882cc7d9eed26d3caeedca027452367ba25f2b9/packages/platform-server/src/http.ts#L44
 * @returns A promise that resolves to an object of type `AngularRouterConfigResult`.
 */
export async function getRoutesFromAngularRouterConfig(
  bootstrap: AngularBootstrap,
  document: string,
  url: URL,
  invokeGetPrerenderParams = false,
): Promise<AngularRouterConfigResult> {
  const { protocol, host } = url;

  // Create and initialize the Angular platform for server-side rendering.
  const platformRef = createPlatformFactory(platformCore, 'server', [
    {
      provide: INITIAL_CONFIG,
      useValue: { document, url: `${protocol}//${host}/` },
    },
    {
      provide: ɵConsole,
      useFactory: () => new Console(),
    },
    ...INTERNAL_SERVER_PLATFORM_PROVIDERS,
  ])();

  try {
    let applicationRef: ApplicationRef;

    if (isNgModule(bootstrap)) {
      const moduleRef = await platformRef.bootstrapModule(bootstrap);
      applicationRef = moduleRef.injector.get(ApplicationRef);
    } else {
      applicationRef = await bootstrap();
    }

    // Wait until the application is stable.
    await whenStable(applicationRef);

    const injector = applicationRef.injector;
    const router = injector.get(Router);
    const routesResults: RouteTreeNodeMetadata[] = [];

    if (router.config.length) {
      const compiler = injector.get(Compiler);

      const serverRoutesConfig = injector.get(SERVER_ROUTES_CONFIG, null, { optional: true });
      const serverConfigRouteTree = serverRoutesConfig
        ? buildServerConfigRouteTree(serverRoutesConfig)
        : undefined;

      // Retrieve all routes from the Angular router configuration.
      const traverseRoutes = traverseRoutesConfig({
        routes: router.config,
        compiler,
        parentInjector: injector,
        parentRoute: '',
        serverConfigRouteTree,
        invokeGetPrerenderParams,
      });

      for await (const result of traverseRoutes) {
        routesResults.push(result);
      }
    } else {
      routesResults.push({ route: '', renderMode: RenderMode.Prerender });
    }

    const baseHref =
      injector.get(APP_BASE_HREF, null, { optional: true }) ??
      injector.get(PlatformLocation).getBaseHrefFromDOM();

    return {
      baseHref,
      routes: routesResults,
    };
  } finally {
    platformRef.destroy();
  }
}

/**
 * Asynchronously extracts routes from the Angular application configuration
 * and creates a `RouteTree` to manage server-side routing.
 *
 * @param url - The URL for server-side rendering. The URL is used to configure `ServerPlatformLocation`. This configuration is crucial
 * for ensuring that API requests for relative paths succeed, which is essential for accurate route extraction.
 * See:
 *  - https://github.com/angular/angular/blob/d608b857c689d17a7ffa33bbb510301014d24a17/packages/platform-server/src/location.ts#L51
 *  - https://github.com/angular/angular/blob/6882cc7d9eed26d3caeedca027452367ba25f2b9/packages/platform-server/src/http.ts#L44
 * @param manifest - An optional `AngularAppManifest` that contains the application's routing and configuration details.
 * If not provided, the default manifest is retrieved using `getAngularAppManifest()`.
 * @param invokeGetPrerenderParams - A boolean flag indicating whether to invoke `getPrerenderParams` for parameterized SSG routes
 * to handle prerendering paths. Defaults to `false`.
 * @returns A promise that resolves to a populated `RouteTree` containing all extracted routes from the Angular application.
 */
export async function extractRoutesAndCreateRouteTree(
  url: URL,
  manifest: AngularAppManifest = getAngularAppManifest(),
  invokeGetPrerenderParams = false,
): Promise<RouteTree> {
  const routeTree = new RouteTree();
  const document = await new ServerAssets(manifest).getIndexServerHtml();
  const bootstrap = await manifest.bootstrap();
  const { baseHref, routes } = await getRoutesFromAngularRouterConfig(
    bootstrap,
    document,
    url,
    invokeGetPrerenderParams,
  );

  for (const { route, ...metadata } of routes) {
    if (metadata.redirectTo !== undefined) {
      metadata.redirectTo = joinUrlParts(baseHref, metadata.redirectTo);
    }

    const fullRoute = joinUrlParts(baseHref, route);
    routeTree.insert(fullRoute, metadata);
  }

  return routeTree;
}