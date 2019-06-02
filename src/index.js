const { utils: helper, TxOp, ContractMode } = require('icetea-common')
const utils = require('./utils')
const { switchEncoding, decodeTX, decodeEventData, decodeTags, decode } = require('./utils')
const Contract = require('./contract/Contract')
const Wallet = require('./wallet/Wallet')
const HttpProvider = require('./providers/HttpProvider')
const WebsocketProvider = require('./providers/WebsocketProvider')

const { signTransaction } = helper

exports.utils = utils

/**
 * The IceTea web client.
 */
exports.IceTeaWeb3 = class IceTeaWeb3 {
  /**
   * Initialize the IceTeaWeb3 instance.
   * @param {string} endpoint tendermint endpoint, e.g. http://localhost:26657
   */
  constructor (endpoint, options) {
    this.isWebSocket = !!(endpoint.startsWith('ws://') || endpoint.startsWith('wss://'))
    if (this.isWebSocket) {
      this.rpc = new WebsocketProvider(endpoint, options)
    } else {
      this.rpc = new HttpProvider(endpoint)
    }

    this.utils = this.constructor.utils = {
      decodeTX,
      decodeEventData,
      decodeTags,
      decode
    }
    this.subscriptions = {}
    this.countSubscribeEvent = 0
    this.wallet = new Wallet()
  }

  close () {
    if (this.isWebSocket) {
      this.rpc.close()
    }
  }
  /**
   * Direct call tendermint.
   * @param {string} method required.
   * @param {*} options optional
   * @return {*} the tendermint infor.
   */
  rawCall (method, options) {
    return this.rpc.call(method, options)
  }
  /**
   * Get a single validators
   * @param {*} options example {height: 10}, skip to get latest block.
   * @returns the validators block.
   */
  getValidators (options) {
    return this.rpc.call('validators', options)
  }

  /**
   * Get account balance.
   * @param {string} address address of the account.
   * @returns {number} account balance.
   */
  getBalance (address) {
    return this.rpc.query('balance', address)
  }

  /**
   * Get a single block.
   * @param {*} options example {height: 10}, skip to get latest block.
   * @returns the tendermint block.
   */
  getBlock (options) {
    return this.rpc.call('block', options)
  }

  /**
   * Get a list of blocks.
   * @param {*} options optional, e.g. {minHeight: 0, maxHeight: 10}
   * @returns {Array} an array of tendermint blocks
   */
  getBlocks (options) {
    return this.rpc.call('blockchain', options)
  }

  /**
   * Get a single transaction.
   * @param {string} hash required, hex string without '0x'.
   * @param {*} options optional, e.g. {prove: true} to request proof.
   * @return {*} the tendermint transaction.
   */
  getTransaction (hash, options) {
    if (!hash) {
      throw new Error('hash is required')
    }
    return this.rpc.call('tx', { hash: switchEncoding(hash, 'hex', 'base64'), ...options })
      .then(decode)
  }

  /**
   * Search for transactions met the query specified.
   * @param {string} query required, query based on tendermint indexed tags, e.g. "tx.height>0".
   * @param {*} options additional options, e.g. {prove: true, page: 2, per_page: 20}
   * @returns {Array} Array of tendermint transactions.
   */
  searchTransactions (query, options) {
    if (!query) {
      throw new Error('query is required, example "tx.height>0"')
    }
    return this.rpc.call('tx_search', { query, ...options })
  }

  /**
   * Search for events emit by contracts.
   * @param {string} eventName the event name, e.g. "Transferred"
   * @param {string} emitter optional, the contract address, or "system"
   * @param {*} conditions required, string or object literal.
   * string example: "tx.height>0 AND someIndexedField CONTAINS 'kkk'".
   * Object example: {fromBlock: 0, toBlock: 100, someIndexedField: "xxx"}.
   * Note that conditions are combined using AND, no support for OR.
   * @param {*} options additional options, e.g. {prove: true, page: 2, per_page: 20}
   * @returns {Array} Array of tendermint transactions containing the event.
   */
  getPastEvents (eventName, emitter, conditions = {}, options) {
    const EVENTNAMES_SEP = '|'
    const EMITTER_EVENTNAME_SEP = '%'

    let query = ''
    if (typeof conditions === 'string') {
      query = conditions
    } else {
      if (!emitter) {
        emitter = EMITTER_EVENTNAME_SEP
      } else {
        emitter = EVENTNAMES_SEP + emitter + EMITTER_EVENTNAME_SEP
      }
      query = Object.keys(conditions).reduce((arr, key) => {
        const value = conditions[key]
        if (key === 'fromBlock') {
          arr.push(`tx.height>${value - 1}`)
        } else if (key === 'toBlock') {
          arr.push(`tx.height<${value + 1}`)
        } else {
          arr.push(`${key}=${value}`)
        }
        return arr
      }, [`EventNames CONTAINS '${emitter}${eventName}${EMITTER_EVENTNAME_SEP}'`]).join(' AND ')
    }

    return this.searchTransactions(query, options)
  }

  /**
   * @param {boolean} preferAlias whether to prefer alias, or just return address.
   * @return {string[]} Get all deployed smart contracts.
   */
  getContracts (preferAlias) {
    return this.rpc.query('contracts', preferAlias)
  }

  /**
   * Get contract metadata.
   * @param {string} contractAddr the contract address.
   * @returns {string[]} methods and fields array.
   */
  getMetadata (contractAddr) {
    return this.rpc.query('metadata', contractAddr)
  }

  /**
   * Get account info.
   * @param {string} contractAddr  the contract address.
   * @returns {{balance: number, code: string | Buffer, mode: number, deployedBy: string, system: boolean}} Contract metadata.
   */
  getAccountInfo (contractAddr) {
    return this.rpc.query('account_info', contractAddr)
  }

  /**
   * @private
   */
  getDebugState () {
    return this.rpc.query('state')
  }

  sendTransaction (tx, signers, waitOption) {
    waitOption = waitOption || (signers && signers.waitOption) || 'commit'
    return _signAndSend(this.rpc, tx, 'broadcast_tx_' + waitOption, this.wallet, signers)
  }

  /**
   * Send a transaction and return immediately.
   * @param {{from: string, to: string, value: number, fee: number, data: Object}} tx the transaction object.
   * @param {object} signers signers
   */
  sendTransactionAsync (tx, signers) {
    return this.sendTransaction(tx, signers, 'async')
  }

  /**
   * Send a transaction and wait until it reach mempool.
   * @param {{from: string, to: string, value: number, fee: number, data: Object}} tx the transaction object.
   * @param {object} signers signers
   */
  sendTransactionSync (tx, signers) {
    return this.sendTransaction(tx, signers, 'sync')
  }

  /**
   * Send a transaction and wait until it is included in a block.
   * @param {{from: string, to: string, value: number, fee: number, data: Object}} tx the transaction object.
   * @param {object} signers signers
   */
  sendTransactionCommit (tx, signers) {
    return this.sendTransaction(tx, signers, 'commit')
  }

  signTransaction (tx, signers) {
    return _signTx(tx, this.wallet, signers)
  }

  sendRawTransaction (tx, waitOption = 'commit') {
    return _sendSignedTx(this.rpc, tx, 'broadcast_tx_' + waitOption)
  }

  /**
   * Call a readonly (@view) contract method or field.
   * @param {string} contract required, the contract address.
   * @param {string} method required, method or field name.
   * @param {Array} params method params, if any.
   * @param {*} options optional options, e.g. {from: 'xxx'}
   */
  callReadonlyContractMethod (contract, method, params = [], options = {}) {
    return this.rpc.query('invokeView', { address: contract, name: method, params, options })
  }

  /**
   * Call a pure (@pure) contract method or field.
   * @param {string} contract required, the contract address.
   * @param {string} method required, method or field name.
   * @param {Array} params method params, if any.
   * @param {*} options optional options, e.g. {from: 'xxx'}
   */
  callPureContractMethod (contract, method, params = [], options = {}) {
    return this.rpc.query('invokePure', { address: contract, name: method, params, options })
  }

  // shorthand for transfer, deploy, write, read contract goes here
  /**
     * Subscribes by event (for WebSocket only)
     *
     * @method subscribe
     *
     * @param {MessageEvent} EventName
     */
  subscribe (eventName, conditions = {}, callback) {
    if (!this.isWebSocket) throw new Error('subscribe for WebSocket only')
    let systemEvent = ['NewBlock', 'NewBlockHeader', 'Tx', 'RoundState', 'NewRound', 'CompleteProposal', 'Vote', 'ValidatorSetUpdates', 'ProposalString']
    let isSystemEvent = true
    let nonSystemEventName
    let space = ''

    if (systemEvent.indexOf(eventName) < 0) {
      isSystemEvent = false
      nonSystemEventName = eventName
      this.countSubscribeEvent += 1
      eventName = 'Tx'
    }

    for (var i = 0; i < this.countSubscribeEvent; i++) {
      space = space + ' '
    }

    var query = ''
    if (typeof conditions === 'string') {
      query = conditions
    } else {
      if (typeof conditions === 'function' && typeof callback === 'undefined') {
        callback = conditions
        conditions = {}
      }
      query = Object.keys(conditions).reduce((arr, key) => {
        const value = conditions[key]
        if (key === 'fromBlock') {
          arr.push(`tx.height>${value - 1}`)
        } else if (key === 'toBlock') {
          arr.push(`tx.height<${value + 1}`)
        } else {
          arr.push(`${key}=${value}`)
        }
        return arr
      }, [`tm.event = ${space}'${eventName}'`]).join(' AND ')
    }

    return this.rpc.call('subscribe', { 'query': query }).then((result) => {
      this.subscriptions[result.id] = {
        id: result.id,
        subscribeMethod: nonSystemEventName || eventName,
        query: query
      }
      // console.log('this.subscriptions',this.subscriptions);
      this.rpc.registerEventListener('onMessage', (message) => {
        let jsonMsg = JSON.parse(message)
        if (result.id && jsonMsg.id.indexOf(result.id) >= 0) {
          if (isSystemEvent) {
            return callback(message)
          } else {
            let events = decodeEventData(jsonMsg.result)
            events.forEach(event => {
              if (event.eventName && nonSystemEventName === event.eventName) {
                let res = {}
                res.jsonrpc = jsonMsg.jsonrpc
                res.id = jsonMsg.id
                res.result = event
                res.result.query = this.subscriptions[result.id].query
                return callback(JSON.stringify(res), null, 2)
              }
            })
          }
        }
      })

      return result
    })
  }
  /**
   * Unsubscribes by event (for WebSocket only)
   *
   * @method unsubscribe
   *
   * @param {SubscriptionId} subscriptionId
   */
  unsubscribe (subscriptionId) {
    if (!this.isWebSocket) throw new Error('unsubscribe for WebSocket only')
    if (typeof this.subscriptions[subscriptionId] !== 'undefined') {
      return this.rpc.call('unsubscribe', { 'query': this.subscriptions[subscriptionId].query }).then((res) => {
        delete this.subscriptions[subscriptionId]
        return res
      })
    }
    return Promise.reject(new Error(`Error: Subscription with ID ${subscriptionId} does not exist.`))
  }

  onMessage (callback) {
    if (!this.isWebSocket) throw new Error('onMessage for WebSocket only')
    this.rpc.registerEventListener('onMessage', callback)
  }

  onResponse (callback) {
    if (!this.isWebSocket) throw new Error('onResponse for WebSocket only')
    this.rpc.registerEventListener('onResponse', callback)
  }

  onError (callback) {
    if (!this.isWebSocket) throw new Error('onError for WebSocket only')
    this.rpc.registerEventListener('onError', callback)
  }

  onClose (callback) {
    if (!this.isWebSocket) throw new Error('onClose for WebSocket only')
    this.rpc.registerEventListener('onClose', callback)
  }

  contract (...args) {
    return new Contract(this, ...args)
  }

  deploy (mode, src, params = [], options = {}) {
    const tx = _serializeData(mode, src, params, options)
    return this.sendTransactionCommit(tx, options)
      .then(res => this.contract(res))
  }

  deployJs (src, params = [], options = {}) {
    return this.deploy(ContractMode.JS_RAW, src, params, options)
  }

  deployWasm (wasmBuffer, params = [], options = {}) {
    return this.deploy(ContractMode.WASM, wasmBuffer, params, options)
  }

  transfer (to, value, options = {}, params = options.params) {
    const tx = { from: options.from, to, value, fee: options.fee }
    if (params) {
      tx.data = { params } // params for __on_received
    }
    return this.sendTransactionCommit(tx, options)
  }
}

function _serializeData (mode, src, params, options) {
  var formData = {}
  var txData = {
    op: TxOp.DEPLOY_CONTRACT,
    mode: mode,
    params: params
  }
  if (mode === ContractMode.JS_DECORATED || mode === ContractMode.JS_RAW) {
    txData.src = switchEncoding(src, 'utf8', 'base64')
  } else {
    if (Buffer.isBuffer(src)) {
      src = Buffer.toString('base64')
    } else if (typeof src !== 'string') {
      throw Error('Wasm binary must be in form of Buffer or base64-encoded string.')
    }
    txData.src = src
  }
  formData.from = options.from
  formData.value = options.value || 0
  formData.fee = options.fee || 0
  formData.data = txData
  return formData
}

function _sendSignedTx (rpc, tx, method) {
  if (typeof tx.data !== 'string') {
    tx.data = JSON.stringify(tx.data)
  }

  if (!tx.evidence || !tx.evidence.length) {
    throw new Error('Transaction was not signed yet.')
  }

  // if (tx.hasOwnProperty('from') && tx.evidence.length === 1 && tx.from === ecc.toAddress(tx.evidence[0].pubkey)) {
  //   delete tx.from // save some bits
  // }

  return rpc.send(method, tx)
    .then(decode)
}

function _signTx (tx, wallet, signers) {
  signers = _extractSigners(tx, signers)
  if (!Array.isArray(signers)) {
    signers = [signers]
  }
  signers.forEach(s => {
    const privateKey = wallet.getPrivateKeyByAddress(s)
    if (!privateKey) throw new Error('Not found private key to sign.')
    tx = signTransaction(tx, privateKey)
  })

  return tx
}

function _signAndSend (rpc, tx, waitOption, wallet, signers) {
  return _sendSignedTx(rpc, _signTx(tx, wallet, signers), waitOption)
}

function _extractSigners (tx, opts) {
  if (!opts) {
    return tx.from
  }

  if (typeof opts === 'string' || Array.isArray(opts)) {
    return opts
  }

  return opts.signers || opts.from || tx.from
}
