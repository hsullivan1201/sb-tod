/**
 * React shim — provides React from the game's API at runtime.
 *
 * At build time, vite aliases `react` and `react/jsx-runtime` imports
 * here. At runtime, we pull React off `window.SubwayBuilderAPI.utils`.
 *
 * IMPORTANT: the new (`jsx-runtime`) JSX functions are NOT the same as
 * `React.createElement`:
 *   - `jsx(type, props, key)` — children live INSIDE `props.children`
 *   - `createElement(type, props, ...children)` — children are rest args
 *
 * Aliasing them directly (which the original template did) causes
 * `React.createElement` to interpret the third arg (the key) as the
 * sole child, so every JSX element with multiple children renders
 * only its key. We adapt explicitly.
 */

const React = window.SubwayBuilderAPI.utils.React;

export default React;
export const {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useReducer,
  useContext,
  createContext,
  createElement,
  Fragment,
} = React;

function jsxAdapter(type: any, props: any, key?: any): any {
  // Pass children inside the props object — call createElement with only
  // two args so it doesn't overwrite props.children with the (missing)
  // rest args.
  if (key !== undefined && key !== null) {
    return React.createElement(type, { ...props, key });
  }
  return React.createElement(type, props);
}

export const jsx = jsxAdapter;
export const jsxs = jsxAdapter;
export const jsxDEV = jsxAdapter;
