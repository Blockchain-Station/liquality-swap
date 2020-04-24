import { replace } from 'connected-react-router'
import BigNumber from 'bignumber.js'
import _ from 'lodash'
import { actions as swapActions } from './swap'
import { actions as assetActions } from './assets'
import { actions as counterPartyActions } from './counterparty'
import cryptoassets from '@liquality/cryptoassets'
import config from '../config'
import { getAgentClient } from '../services/agentClient'
import { isAgentRequestValid } from '../utils/validation'
import { sleep } from '../utils/async'
import { pickMarket } from '../utils/agent'

const types = {
  SET_QUOTE: 'SET_QUOTE',
  SET_MARKETS: 'SET_MARKETS',
  SET_MARKET: 'SET_MARKET'
}

function setMarket (from, to) {
  return async (dispatch, getState) => {
    const { agent: { markets }, assets: { a: assetA } } = getState().swap
    if (!markets) return

    dispatch(assetActions.setAsset('a', from))
    dispatch(assetActions.setAsset('b', to))

    const market = pickMarket(markets, from, to, assetA.value) // TODO: OR GET CLOSEST MATCH
    if (market) {
      dispatch({ type: types.SET_MARKET, market: market })
      dispatch(assetActions.changeRate(market.rate))
    }
  }
}

// Should market updates be allowed? Prevent updates to rates and amounts
function shouldUpdateMarkets (getState) {
  return !(getState().swap.agent.quote) && getState().router.location.pathname !== '/assetSelection'
}

async function getMarkets (agent) {
  const marketInfo = await getAgentClient(agent).getMarketInfo()
  const formattedMarkets = marketInfo.map(m => {
    const convertedMin = cryptoassets[m.from.toLowerCase()].unitToCurrency(m.min)
    const convertedMax = cryptoassets[m.from.toLowerCase()].unitToCurrency(m.max)
    return {
      ...m,
      min: convertedMin,
      max: convertedMax,
      from: m.from.toLowerCase(),
      to: m.to.toLowerCase(),
      rate: BigNumber(m.rate),
      agent
    }
  })
  return formattedMarkets
}

async function getAllMarkets () {
  const agentMarketsPromises = config.agents.map(agent => getMarkets(agent))
  const agentMarkets = await Promise.all(agentMarketsPromises)
  const markets = _.flatten(agentMarkets)
  const configuredAssets = Object.keys(config.assets)
  const validMarkets = markets.filter(market => configuredAssets.includes(market.to) && configuredAssets.includes(market.from))
  return validMarkets
}

async function setMarkets (dispatch, getState) {
  const markets = await getAllMarkets()
  if (!shouldUpdateMarkets(getState)) return

  dispatch({ type: types.SET_MARKETS, markets: markets })
  const { agent, assets: { a: assetA, b: assetB } } = getState().swap
  let marketToSet
  if (agent.market) {
    marketToSet = agent.markets.find(market => assetA.currency === market.from && assetB.currency === market.to)
  } else {
    marketToSet = agent.markets[0] // Default market
  }

  dispatch(setMarket(marketToSet.from, marketToSet.to))
}

function connectAgents () {
  return async (dispatch, getState) => {
    while (shouldUpdateMarkets(getState)) {
      await setMarkets(dispatch, getState)
      await sleep(4000)
    }
  }
}

function setQuote (quote) {
  return { type: types.SET_QUOTE, quote }
}

function retrieveAgentQuote () {
  return async (dispatch, getState) => {
    dispatch(swapActions.showErrors())
    if (isAgentRequestValid(getState().swap)) {
      const { assets: { a: assetA, b: assetB }, agent: { markets } } = getState().swap
      const market = pickMarket(markets, assetA.currency, assetB.currency, assetA.value)
      const amount = cryptoassets[assetA.currency].currencyToUnit(assetA.value)
      const quote = await getAgentClient(market.agent).getQuote(assetA.currency, assetB.currency, amount.toNumber()) // TODO: This should be passed as BigNumber
      dispatch(setQuote({...quote, agent: market.agent}))

      dispatch(assetActions.changeAmount('a', cryptoassets[assetA.currency].unitToCurrency(quote.fromAmount)))
      dispatch(assetActions.changeAmount('b', cryptoassets[assetB.currency].unitToCurrency(quote.toAmount)))
      dispatch(assetActions.changeAmount('b', cryptoassets[assetB.currency].unitToCurrency(quote.toAmount)))

      dispatch(assetActions.lockRate())
      dispatch(counterPartyActions.changeCounterPartyAddress('a', quote.fromCounterPartyAddress))
      dispatch(counterPartyActions.changeCounterPartyAddress('b', quote.toCounterPartyAddress))
      dispatch(counterPartyActions.setCounterPartyVisible(false))
      dispatch(replace('/offerConfirmation'))
      dispatch(swapActions.hideErrors())
    }
  }
}

const actions = {
  connectAgents,
  setMarket,
  setQuote,
  retrieveAgentQuote
}

export { types, actions }
