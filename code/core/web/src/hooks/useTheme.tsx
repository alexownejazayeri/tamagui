import React from 'react'
import { isClient, isIos, isServer, isWeb } from '@tamagui/constants'

import { getConfig, getSetting } from '../config'
import type { Variable } from '../createVariable'
import { getVariable } from '../createVariable'
import type { ThemeManagerState } from '../helpers/ThemeManager'
import { ThemeManager, getHasThemeUpdatingProps } from '../helpers/ThemeManager'
import { ThemeManagerIDContext } from '../helpers/ThemeManagerContext'
import { isEqualShallow } from '../helpers/createShallowSetState'
import type {
  DebugProp,
  ThemeParsed,
  ThemeProps,
  Tokens,
  UseThemeWithStateProps,
  VariableVal,
  VariableValGeneric,
} from '../types'

export type ChangedThemeResponse = {
  state?: ThemeManagerState
  prevState?: ThemeManagerState
  themeManager?: ThemeManager | null
  isNewTheme: boolean
  // null = never been inversed
  // false = was inversed, now not
  inversed?: null | boolean
  mounted?: boolean
}

const emptyProps = { name: null }

let cached: any
function getDefaultThemeProxied() {
  if (cached) return cached
  const config = getConfig()
  const name = config.themes.light ? 'light' : Object.keys(config.themes)[0]
  const defaultTheme = config.themes[name]
  cached = getThemeProxied({ theme: defaultTheme, name })
  return cached
}

export type ThemeGettable<Val> = Val & {
  /**
   * Tries to return an optimized value that avoids the need for re-rendering:
   * On web a CSS variable, on iOS a dynamic color, on Android it doesn't
   * optimize and returns the underyling value.
   *
   * See: https://reactnative.dev/docs/dynamiccolorios
   *
   * @param platform when "web" it will only return the dynamic value for web, avoiding the iOS dynamic value.
   * For things like SVG, gradients, or other external components that don't support it, use this option.
   */
  get: (
    platform?: 'web'
  ) =>
    | string
    | (Val extends Variable<infer X>
        ? X extends VariableValGeneric
          ? any
          : Exclude<X, Variable>
        : Val extends VariableVal
          ? string | number
          : unknown)
}

export type UseThemeResult = {
  [Key in keyof ThemeParsed | keyof Tokens['color']]: ThemeGettable<
    Key extends keyof ThemeParsed ? ThemeParsed[Key] : Variable<any>
  >
} & {
  // fallback to other tokens
  [Key in string & {}]?: ThemeGettable<Variable<any>>
}

// not used by anything but its technically more correct type, but its annoying to have in intellisense so leaving it
// type SimpleTokens = NonSpecificTokens extends `$${infer Token}` ? Token : never
// export type UseThemeWithTokens = {
//   [Key in keyof ThemeParsed | keyof SimpleTokens]: ThemeGettable<
//     Key extends keyof ThemeParsed
//       ? ThemeParsed[Key]
//       : Variable<ThemeValueGet<`$${Key}`> extends never ? any : ThemeValueGet<`$${Key}`>>
//   >
// }

export const useTheme = (props: ThemeProps = emptyProps) => {
  const [_, theme] = useThemeWithState(props)
  const res = theme || getDefaultThemeProxied()
  return res as UseThemeResult
}

export const useThemeWithState = (
  props: UseThemeWithStateProps
): [ChangedThemeResponse, ThemeParsed] => {
  const keys = React.useRef<string[]>([])

  const changedThemeState = useChangeThemeEffect(
    props,
    false,
    keys.current,
    !isServer
      ? () => {
          const next =
            props.shouldUpdate?.() ?? (keys.current.length > 0 ? true : undefined)

          if (
            process.env.NODE_ENV === 'development' &&
            typeof props.debug === 'string' &&
            props.debug !== 'profile'
          ) {
            console.info(
              `  🎨 useTheme() shouldUpdate?`,
              next,
              isClient
                ? {
                    shouldUpdateProp: props.shouldUpdate?.(),
                    keys: [...keys.current],
                  }
                : ''
            )
          }

          return next
        }
      : undefined
  )

  const { themeManager, state } = changedThemeState

  if (process.env.NODE_ENV === 'development') {
    if (!state?.theme) {
      if (process.env.TAMAGUI_DISABLE_NO_THEME_WARNING !== '1') {
        console.error(
          `[tamagui] No theme found, this could be due to an invalid theme name (given theme props ${JSON.stringify(
            props
          )}).\n\nIf this is intended and you are using Tamagui without any themes, you can disable this warning by setting the environment variable TAMAGUI_DISABLE_NO_THEME_WARNING=1`
        )
      }
    }
  }

  const themeProxied = React.useMemo(() => {
    if (!themeManager || !state?.theme) {
      return {}
    }
    return getThemeProxied(state, props.deopt, themeManager, keys.current, props.debug)
  }, [state?.theme, themeManager, props.deopt, props.debug])

  if (process.env.NODE_ENV === 'development' && props.debug === 'verbose') {
    console.groupCollapsed(`  🔹 [${themeManager?.id}] useTheme =>`, state?.name)
    console.info('returning state', changedThemeState, 'from props', props)
    console.groupEnd()
  }

  return [changedThemeState, themeProxied]
}

export function getThemeProxied(
  { theme, name, scheme }: ThemeManagerState,
  deopt = false,
  themeManager?: ThemeManager,
  keys?: string[],
  debug?: DebugProp
): UseThemeResult {
  if (!theme) return {}

  const config = getConfig()

  function track(key: string) {
    if (keys && !keys.includes(key)) {
      if (!keys.length) {
        // tracking new key for first time, do an update check
        setTimeout(() => {
          themeManager?.selfUpdate()
        })
      }

      keys.push(key)
      if (process.env.NODE_ENV === 'development' && debug) {
        console.info(` 🎨 useTheme() tracking new key: ${key}`)
      }
    }
  }

  return new Proxy(theme, {
    has(_, key) {
      if (Reflect.has(theme, key)) {
        return true
      }
      if (typeof key === 'string') {
        if (key[0] === '$') key = key.slice(1)
        return themeManager?.allKeys.has(key)
      }
    },
    get(_, key) {
      if (
        // dont ask me, idk why but on hermes you can see that useTheme()[undefined] passes in STRING undefined to proxy
        // if someone is crazy enough to use "undefined" as a theme key then this not working is on them
        key !== 'undefined' &&
        typeof key === 'string'
      ) {
        // auto convert variables to plain
        const keyString = key[0] === '$' ? key.slice(1) : key
        const val = theme[keyString]

        if (val && typeof val === 'object') {
          // TODO this could definitely be done better by at the very minimum
          // proxying it up front and just having a listener here
          return new Proxy(val as any, {
            // when they touch the actual value we only track it
            // if its a variable (web), its ignored!
            get(_, subkey) {
              if (subkey === 'val') {
                // always track .val
                track(keyString)
              } else if (subkey === 'get') {
                return (platform?: 'web') => {
                  const outVal = getVariable(val)

                  if (process.env.TAMAGUI_TARGET === 'native') {
                    // ios can avoid re-rendering in some cases when we are using a root light/dark
                    // disabled in cases where we have animations
                    if (
                      platform !== 'web' &&
                      isIos &&
                      !deopt &&
                      getSetting('fastSchemeChange') &&
                      !someParentIsInversed(themeManager)
                    ) {
                      if (scheme) {
                        const oppositeThemeName = name.replace(
                          scheme === 'dark' ? 'dark' : 'light',
                          scheme === 'dark' ? 'light' : 'dark'
                        )
                        const oppositeTheme = config.themes[oppositeThemeName]
                        const oppositeVal = getVariable(oppositeTheme?.[keyString])
                        if (oppositeVal) {
                          const dynamicVal = {
                            dynamic: {
                              dark: scheme === 'dark' ? outVal : oppositeVal,
                              light: scheme === 'light' ? outVal : oppositeVal,
                            },
                          }
                          return dynamicVal
                        }
                      }
                    }

                    // if we dont return early with a dynamic val on native, always track
                    track(keyString)
                  }

                  return outVal
                }
              }

              return Reflect.get(val as any, subkey)
            },
          })
        }

        if (
          process.env.NODE_ENV === 'development' &&
          process.env.TAMAGUI_FEAT_THROW_ON_MISSING_THEME_VALUE === '1'
        ) {
          throw new Error(
            `[tamagui] No theme key "${key}" found in theme ${name}. \n  Keys in theme: ${Object.keys(
              theme
            ).join(', ')}`
          )
        }
      }

      return Reflect.get(_, key)
    },
  }) as UseThemeResult
}

// to tell if we are inversing the scheme anywhere in the tree, if so we need to de-opt
function someParentIsInversed(manager?: ThemeManager) {
  if (process.env.TAMAGUI_TARGET === 'native') {
    let cur: ThemeManager | null | undefined = manager
    while (cur) {
      if (!cur.parentManager) return false
      if (cur.parentManager.state.scheme !== cur.state.scheme) return true
      cur = cur.parentManager
    }
  }
  return false
}

export const activeThemeManagers = new Set<ThemeManager>()

// until WeakRef support:
const _uidToManager = new WeakMap<Object, ThemeManager>()
const _idToUID: Record<number, Object> = {}
const getId = (id: number) => _idToUID[id]

export const getThemeManager = (id: number) => {
  return _uidToManager.get(getId(id)!)
}

const registerThemeManager = (t: ThemeManager) => {
  if (!_idToUID[t.id]) {
    const id = (_idToUID[t.id] = {})
    _uidToManager.set(id, t)
  }
}

const ogLog = console.error
const preventWarnSetState =
  process.env.NODE_ENV === 'production'
    ? ogLog
    : // temporary fix for logs, they are harmless in that i've tried to rewrite this
      // a few times using the "right" ways, but they are always slower. maybe skill issue
      (a?: any, ...args: any[]) => {
        if (typeof a === 'string' && a.includes('Cannot update a component')) {
          return
        }
        return ogLog(a, ...args)
      }

export const useChangeThemeEffect = (
  props: UseThemeWithStateProps,
  isRoot = false,
  keys?: string[],
  shouldUpdate?: () => boolean | undefined
): ChangedThemeResponse => {
  const { disable } = props
  const parentManagerId = React.useContext(ThemeManagerIDContext)
  const parentManager = getThemeManager(parentManagerId)

  if ((!isRoot && !parentManager) || disable) {
    return {
      isNewTheme: false,
      state: parentManager?.state,
      themeManager: parentManager,
    }
  }

  // to test performance: uncomment
  // if (!disable && parentManager) {
  //   return {
  //     isNewTheme: false,
  //     state: {
  //       name: 'light',
  //       theme: getConfig().themes.light,
  //     },
  //     themeManager: parentManager!,
  //   }
  // }

  const [themeState, setThemeState] = React.useState<ChangedThemeResponse>(createState)

  const { state, mounted, isNewTheme, themeManager, inversed, prevState } = themeState
  const isInversingOnMount = Boolean(!themeState.mounted && props.inverse)

  function getShouldUpdateTheme(
    manager = themeManager,
    nextState?: ThemeManagerState | null,
    prevState: ThemeManagerState | undefined = state,
    forceShouldChange = false
  ) {
    const forceUpdate = shouldUpdate?.()
    if (!manager || (!forceShouldChange && forceUpdate === false)) return
    const next = nextState || manager.getState(props, parentManager)
    if (forceShouldChange) return next
    if (!next) return
    if (forceUpdate !== true && !manager.getStateShouldChange(next, prevState)) {
      return
    }

    return next
  }

  if (!isServer) {
    React.useLayoutEffect(() => {
      // one homepage breaks on useTheme() in MetaTheme if this isnt set up
      if (themeManager && state && prevState && state !== prevState) {
        themeManager.notify()
      }
    }, [state])

    // listen for parent change + notify children change
    React.useEffect(() => {
      if (!themeManager) return

      // SSR safe inverse (because server can't know prefers scheme)
      // could be done through fancy selectors like how we do prefers-media
      // but may be a bit of explosion of selectors
      if (props.inverse && !mounted) {
        setThemeState((prev) => {
          return createState({
            ...prev,
            mounted: true,
          })
        })
        return
      }

      if (isNewTheme || getShouldUpdateTheme(themeManager)) {
        activeThemeManagers.add(themeManager)
        setThemeState(createState)
      }

      // for updateTheme/replaceTheme
      const selfListenerDispose = themeManager.onChangeTheme((_a, _b, forced) => {
        if (forced) {
          setThemeState((prev) => {
            const next = createState(prev, !!forced)
            return next
          })
        }
      }, true)

      const disposeChangeListener = parentManager?.onChangeTheme(
        (name, manager, forced) => {
          const force =
            forced ||
            shouldUpdate?.() ||
            props.deopt ||
            // this fixes themeable() not updating with the new fastSchemeChange setting
            (process.env.TAMAGUI_TARGET === 'native'
              ? props['disable-child-theme']
              : undefined)

          const shouldTryUpdate = force ?? Boolean(keys?.length || isNewTheme)

          if (process.env.NODE_ENV === 'development' && props.debug === 'verbose') {
            // prettier-ignore
            console.info(` 🔸 onChange`, themeManager.id, {
              force,
              shouldTryUpdate,
              props,
              name,
              manager,
              keys,
            })
          }

          if (shouldTryUpdate) {
            setThemeState((prev) => createState(prev, force))
          }
        },
        themeManager.id
      )

      return () => {
        selfListenerDispose()
        disposeChangeListener?.()
        if (isNewTheme) {
          activeThemeManagers.delete(themeManager)
        }
      }
    }, [
      themeManager,
      parentManager,
      isNewTheme,
      props.componentName,
      props.inverse,
      props.name,
      props.reset,
      mounted,
    ])

    if (process.env.NODE_ENV === 'development' && props.debug !== 'profile') {
      React.useEffect(() => {
        globalThis['TamaguiThemeManagers'] ??= new Set()
        globalThis['TamaguiThemeManagers'].add(themeManager)
        return () => {
          globalThis['TamaguiThemeManagers'].delete(themeManager)
        }
      }, [themeManager])
    }
  }

  if (isWeb && isInversingOnMount) {
    return {
      isNewTheme: false,
      inversed: false,
      themeManager: parentManager,
      state: {
        name: '',
        ...parentManager?.state,
        className: '',
      },
    }
  }

  return {
    state,
    isNewTheme,
    inversed,
    themeManager,
  }

  function createState(prev?: ChangedThemeResponse, force = false): ChangedThemeResponse {
    if (prev && shouldUpdate?.() === false && !force) {
      return prev
    }

    //  returns previous theme manager if no change
    let themeManager: ThemeManager = parentManager!
    let state: ThemeManagerState | undefined
    const hasThemeUpdatingProps = getHasThemeUpdatingProps(props)

    if (hasThemeUpdatingProps) {
      const getNewThemeManager = () => {
        return new ThemeManager(props, isRoot ? 'root' : parentManager)
      }

      if (prev?.themeManager) {
        themeManager = prev.themeManager

        // this could be a bit better, problem is on toggling light/dark the state is actually
        // showing light even when the last was dark. but technically allso onChangeTheme should
        // basically always call on a change, so i'm wondering if we even need the shouldUpdate
        // at all anymore. this forces updates onChangeTheme for all dynamic style accessed components
        // which is correct, potentially in the future we can avoid forceChange and just know to
        // update if keys.length is set + onChangeTheme called
        const forceChange = force || Boolean(keys?.length)
        const next = themeManager.getState(props, parentManager)
        const nextState = getShouldUpdateTheme(
          themeManager,
          next,
          prev.state,
          forceChange
        )

        if (nextState) {
          state = nextState

          if (!prev.isNewTheme && !isRoot) {
            themeManager = getNewThemeManager()
          } else {
            themeManager.updateState(nextState)
          }
        } else {
          if (prev.isNewTheme) {
            // reset to parent
            if (parentManager && !next) {
              themeManager = parentManager
            }
          }
        }
      } else {
        themeManager = getNewThemeManager()
        state = { ...themeManager.state }
      }
    }

    const isNewTheme = Boolean(themeManager !== parentManager || props.inverse)

    if (isNewTheme) {
      registerThemeManager(themeManager)
    }

    const isWebSSR = isWeb ? !getSetting('disableSSR') : false
    const mounted = isWebSSR ? isRoot || prev?.mounted : true

    if (!state) {
      if (isNewTheme) {
        state = themeManager.state
      } else {
        state = parentManager!.state
        themeManager = parentManager!
      }
    }

    const wasInversed = prev?.inversed
    const isInherentlyInversed =
      isNewTheme && state.scheme !== parentManager?.state.scheme
    const inversed = isRoot
      ? false
      : isInherentlyInversed
        ? true
        : isWebSSR
          ? wasInversed != null
            ? false
            : null
          : props.inverse

    const response: ChangedThemeResponse = {
      themeManager,
      isNewTheme,
      mounted,
      inversed,
    }

    const shouldReturnPrev =
      prev &&
      !force &&
      // isEqualShallow uses the second arg as the keys so this should compare without state first...
      isEqualShallow(prev, response) &&
      // ... and then compare just the state, because we make a new state obj but is likely the same
      isEqualShallow(prev.state, state)

    if (prev && shouldReturnPrev) {
      return prev
    }

    // after we compare equal we set the state
    response.state = state
    response.prevState = prev?.state

    if (process.env.NODE_ENV === 'development' && props['debug'] && isClient) {
      console.groupCollapsed(`🔷 [${themeManager.id}] useChangeThemeEffect createState`)
      const parentState = { ...parentManager?.state }
      const parentId = parentManager?.id
      const themeManagerState = { ...themeManager.state }
      console.info({
        props,
        parentState,
        parentId,
        themeManager,
        prev,
        response,
        themeManagerState,
      })
      console.groupEnd()
    }

    return response
  }
}
