module.exports = Peer

var debug = require('debug')('connect-peer-module')
var inherits = require('inherits')
var getBrowserRTC = require('get-browser-rtc')
var stream = require('readable-stream')
var randombytes = require('randombytes')

var CHANNEL_CLOSING_TIMEOUT = 5 * 1000
var ICECOMPLETE_TIMEOUT = 5 * 1000
var BUFFERED_AMOUNT = 64 * 1024  //  the number of bytes of data currently queued to be sent over the data channel

inherits(Peer, stream.Duplex)

function Peer (opts) {
  var connect = this

  if (!(connect instanceof Peer)){
    return new Peer(opts)
  }

  connect._id = randombytes(4).toString('hex').slice(0, 7)
  connect.process('new peer %o', opts)

  opts = Object.assign({
    allowHalfOpen: false
  }, opts)

  stream.Duplex.call(connect, opts)
  connect.channelName = opts.init ? opts.channelName || randombytes(20).toString('hex'): null

  connect.remoteAddress = undefined
  connect.remoteFamily = undefined
  connect.remotePort = undefined
  connect.localAddress = undefined
  connect.localFamily = undefined
  connect.localPort = undefined

  connect.destroyed = false
  connect.connected = false
  connect.modify = false
  connect.allowHalfTrickle = false

  connect.init = opts.init || false
  connect.channelConfig = opts.channelConfig || Peer.channelConfig
  connect.config = Object.assign({}, Peer.config, opts.config)
  connect.offerOptions = opts.offerOptions || {}
  connect.answerOptions = opts.answerOptions || {}
  connect.sdpTransform = opts.sdpTransform || function (sdp) { return sdp }
  connect.iceCompleteTimeout = opts.iceCompleteTimeout || ICECOMPLETE_TIMEOUT

  connect._wrtc = (opts.wrtc && typeof opts.wrtc === 'object') ? opts.wrtc: getBrowserRTC()

  if (!connect._wrtc) {
    if (typeof window === 'undefined') {
      throw errorMessage('Error witch webRTC module support', 'ERR_WEBRTC_SUPPORT')
    } else {
      throw errorMessage('No WebRTC support: Not a supported browser', 'ERR_WEBRTC_SUPPORT')
    }
  }

  connect.isNegotiating = !connect.init 
  connect.batchedNegotiation = false 
  connect.queuedNegotiation = false 
  connect.sendersAwaitingStable = []
  connect.senderMap = new Map()
  connect.firstStable = true
  connect.closingInterval = null
  connect.standby = false
  connect.channelReady = false
  connect.iceComplete = false 
  connect.iceCompleteTimer = null 
  connect.peerChannel = null
  connect.pendingCandidates = []
  connect.chunk = null
  connect.cb = null
  connect.border = null

  try {
    connect.work = new (connect._wrtc.RTCPeerConnection)(connect.config)
  } catch (error) {
    connect.destroy(error)
  }

  connect._isReactNativeWebrtc = typeof connect.work._peerConnectionId === 'number'

  connect.work.oniceconnectionstatechange = function () {
    connect._onIceStateChange()
  }
  connect.work.onicegatheringstatechange = function () {
    connect._onIceStateChange()
  }
  connect.work.onsignalingstatechange = function () {
    connect._onSignalingStateChange()
  }
  connect.work.onicecandidate = function (event) {
    connect._onIceCandidate(event)
  }

  if (connect.init) {
    connect.preparation({
      channel: connect.work.createDataChannel(connect.channelName, connect.channelConfig)
    })
  } else {
    connect.work.ondatachannel = function (event) {
      connect.preparation(event)
    }
  }

  if (connect.init) {
    connect._needsNegotiation()
  }

  connect._onFinishBound = function () {
    connect.thisIsTheEnd()
  }
  connect.once('finish', connect._onFinishBound)
}

Peer.WEBRTC_SUPPORT = !!getBrowserRTC()

Peer.config = {
  iceServers: [  
    { urls: 'stun:stun.l.google.com:19302'},
    { urls: 'stun:global.stun.twilio.com:3478?transport=udp'}
  ],
  sdpSemantics: 'unified-plan'
}
Peer.channelConfig = {}

function errorMessage (message, code) {
  var error = new Error(message)
  error.code = code
  return error
}

Peer.prototype.preparation = function (event) {
  var connect = this
  if (!event.channel) {
    return connect.destroy(errorMessage('Missing property', 'ERR_DATA_CHANNEL'))
  }

  connect.peerChannel = event.channel
  connect.peerChannel.binaryType = 'arraybuffer'

  if (typeof connect.peerChannel.bufferedAmountLowThreshold === 'number') {
    connect.peerChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT
  }

  connect.channelName = connect.peerChannel.label

  connect.peerChannel.onmessage = function (event) {
    connect._onChannelMessage(event)
  }
  connect.peerChannel.onbufferedamountlow = function () {
    connect._onChannelBufferedAmountLow()
  }
  connect.peerChannel.onopen = function () {
    connect._onChannelOpen()
  }
  connect.peerChannel.onclose = function () {
    connect._onChannelClose()
  }
  connect.peerChannel.onerror = function (error) {
    connect.destroy(errorMessage(error, 'ERR_DATA_CHANNEL'))
  }

  var isClosing = false
  connect.closingInterval = setInterval(function () { 
    if (connect.peerChannel && connect.peerChannel.readyState === 'closing') {
      if (isClosing) connect._onChannelClose() 
      isClosing = true
    } else {
      isClosing = false
    }
  }, CHANNEL_CLOSING_TIMEOUT)
}

Object.defineProperty(Peer.prototype, 'bufferSize', {
  get: function () {
    var connect = this
    return (connect.peerChannel && connect.peerChannel.bufferedAmount) || 0
  }
})

Peer.prototype.address = function () {
  var connect = this
  return { 
    port: connect.localPort, family: connect.localFamily, address: connect.localAddress
  }
}

Peer.prototype.signal = function (data) {
  var connect = this
  if (connect.destroyed) throw errorMessage('Signaling error', 'ERR_SIGNALING')
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch (error) {
      data = {}
    }
  }
  connect.process('signal()')

  if (data.renegotiate && connect.init) {
    connect.process('got request to renegotiate')
    connect._needsNegotiation()
  }
  if (data.transceiverRequest && connect.init) {
    connect.process('got request for transceiver')
    connect.addTransceiver(data.transceiverRequest.kind, data.transceiverRequest.init)
  }
  if (data.candidate) {
    if (connect.work.localDescription && connect.work.localDescription.type && connect.work.remoteDescription && connect.work.remoteDescription.type) {
      connect._addIceCandidate(data.candidate)
    } else {
      connect.pendingCandidates.push(data.candidate)
    }
  }
  if (data.sdp) {
    connect.work.setRemoteDescription(new (connect._wrtc.RTCSessionDescription)(data)).then(function () {
      if (connect.destroyed) return
      connect.pendingCandidates.forEach(function (candidate) {
        connect._addIceCandidate(candidate)
      })
      connect.pendingCandidates = []
      if (connect.work.remoteDescription.type === 'offer') connect._createAnswer()
    }).catch(function (error) { connect.destroy(errorMessage(error, 'ERR_SET_REMOTE_DESCRIPTION')) })
  }
  if (!data.sdp && !data.candidate && !data.renegotiate && !data.transceiverRequest) {
    connect.destroy(errorMessage('invalid signal data', 'ERR_SIGNALING'))
  }
}

Peer.prototype._addIceCandidate = function (candidate) {
  var connect = this
  connect.work.addIceCandidate(new connect._wrtc.RTCIceCandidate(candidate)).catch(function (error) {
    if (connect.work.signalingState !== 'closed' && error.message === 'Failed to set ICE candidate; RTCPeerConnection is d.') {
      return connect.process('ignoring incorrect wrtc error')
    }
    connect.destroy(errorMessage(error, 'ERR_ADD_ICE_CANDIDATE'))
  })
}

// Send data. Complex data <- USE stringify
Peer.prototype.send = function (chunk) {
  var connect = this
  connect.peerChannel.send(chunk)
}

Peer.prototype.addTransceiver = function (kind, init) {
  var connect = this
  connect.process('addTransceiver()')

  if (connect.init) {
    try {
      connect.work.addTransceiver(kind, init)
      connect._needsNegotiation()
    } catch (error) {
      connect.destroy(error)
    }
  } else {
    connect.emit('signal', { 
      transceiverRequest: { kind, init }
    })
  }
}

Peer.prototype._needsNegotiation = function () {
  var connect = this
  connect.process('_needsNegotiation')
  if (connect.batchedNegotiation) return 
  connect.batchedNegotiation = true
  setTimeout(function () {
    connect.batchedNegotiation = false
    connect.process('starting batched negotiation')
    connect.negotiate()
  }, 0)
}

Peer.prototype.negotiate = function () {
  var connect = this
  if (connect.init) {
    if (connect.isNegotiating) {
      connect.queuedNegotiation = true
      connect.process('already negotiating, queueing')
    } else {
      connect.process('start negotiation')
      setTimeout(() => { 
        connect._createOffer()
      }, 0)
    }
  } else {
    if (!connect.isNegotiating) {
      connect.process('requesting negotiation from init')
      connect.emit('signal', { 
        renegotiate: true
      })
    }
  }
  connect.isNegotiating = true
}


Peer.prototype.destroy = function (error) {
  var connect = this
  connect.end(error, function () {})
}

Peer.prototype.end = function (error, cb) {
  var connect = this
  if (connect.destroyed) return

  connect.process('destroy (error: %s)', error && (error.message || error))
  connect.readable = connect.writable = false

  if (!connect._readableState.ended) connect.push(null)
  if (!connect._writableState.finished) connect.end()

  connect.destroyed = true
  connect.connected = false
  connect.standby = false
  connect.channelReady = false
  connect.senderMap = null

  clearInterval(connect.closingInterval)
  connect.closingInterval = null

  clearInterval(connect.border)
  connect.border = null
  connect.chunk = null
  connect.cb = null

  if (connect._onFinishBound) connect.removeListener('finish', connect._onFinishBound)
  connect._onFinishBound = null

  if (connect.peerChannel) {
    try {
      connect.peerChannel.close()
    } catch (error) {}
    connect.peerChannel.onmessage = null
    connect.peerChannel.onopen = null
    connect.peerChannel.onclose = null
    connect.peerChannel.onerror = null
  }
  if (connect.work) {
    try {
      connect.work.close()
    } catch (error) {}

    connect.work.oniceconnectionstatechange = null
    connect.work.onicegatheringstatechange = null
    connect.work.onsignalingstatechange = null
    connect.work.onicecandidate = null
    connect.work.ontrack = null
    connect.work.ondatachannel = null
  }
  connect.work = null
  connect.peerChannel = null

  if (error) connect.emit('error', error)
  connect.emit('close')
  cb()
}

Peer.prototype._read = function () {}

Peer.prototype._write = function (chunk, encoding, cb) {
  var connect = this
  if (connect.destroyed) return cb(errorMessage('peer is destroyed', 'ERR_DATA_CHANNEL'))

  if (connect.connected) {
    try {
      connect.send(chunk)
    } catch (error) {
      return connect.destroy(errorMessage(error, 'ERR_DATA_CHANNEL'))
    }
    if (connect.peerChannel.bufferedAmount > BUFFERED_AMOUNT) {
      connect.process('start backpressure: bufferedAmount %d', connect.peerChannel.bufferedAmount)
      connect.cb = cb
    } else {
      cb(null)
    }
  } else {
    connect.process('write before connect')
    connect.chunk = chunk
    connect.cb = cb
  }
}

Peer.prototype.sessionFinish = function () {
  var connect = this
  connect.destroyed = true
  connect.connected = false
  connect.standby = false
  connect.channelReady = false
  connect.senderMap = null

  clearInterval(connect.closingInterval)
  connect.closingInterval = null

  clearInterval(connect.border)
  connect.border = null
  connect.chunk = null
  connect.cb = null

  connect.work.close()

  connect.work.oniceconnectionstatechange = null
  connect.work.onicegatheringstatechange = null
  connect.work.onsignalingstatechange = null
  connect.work.onicecandidate = null
  connect.work.ontrack = null
  connect.work.ondatachannel = null

  connect.work = null
  connect.peerChannel = null
  return
}

Peer.prototype.thisIsTheEnd = function () {
  var connect = this
  if (connect.destroyed) return
  if (connect.connected) {
    destroySoon()
  } else {
    connect.once('connect', destroySoon)
  }
  function destroySoon () {
    setTimeout(function () {
      connect.destroy()
    }, 1500)
  }
}

Peer.prototype._startIceCompleteTimeout = function () {
  var connect = this
  if (connect.destroyed) return
  if (connect.iceCompleteTimer) return
  connect.process('started iceComplete timeout')
  connect.iceCompleteTimer = setTimeout(function () {
    if (!connect.iceComplete) {
      connect.iceComplete = true
      connect.process('iceComplete timeout completed')
      connect.emit('iceTimeout')
      connect.emit('iceComplete')
    }
  }, connect.iceCompleteTimeout)
}

Peer.prototype._createOffer = function () {
  var connect = this
  if (connect.destroyed) return
  connect.work.createOffer(connect.offerOptions).then(function (offer) {
    if (connect.destroyed) return
    offer.sdp = filterTrickle(offer.sdp)
    offer.sdp = connect.sdpTransform(offer.sdp)
    connect.work.setLocalDescription(offer).then(onSuccess).catch(onError)

    function onSuccess () {
      connect.process('createOffer success')
      if (connect.destroyed) return
      if (connect.modify || connect.iceComplete) sendOffer()
      else connect.once('iceComplete', sendOffer) 
    }

    function onError (error) {
      connect.destroy(errorMessage(error, 'ERR_SET_LOCAL_DESCRIPTION'))
    }

    function sendOffer () {
      if (connect.destroyed) return
      var signal = connect.work.localDescription || offer
      connect.process('signal')
      connect.emit('signal', {
        type: signal.type,
        sdp: signal.sdp
      })
    }
  }).catch(function (error) { connect.destroy(errorMessage(error, 'ERR_CREATE_OFFER')) })
}

Peer.prototype._requestMissingTransceivers = function () {
  var connect = this
  if (connect.work.getTransceivers) {
    connect.work.getTransceivers().forEach(transceiver => {
      if (!transceiver.mid && transceiver.sender.track) {
        connect.addTransceiver(transceiver.sender.track.kind)
      }
    })
  }
}

Peer.prototype._createAnswer = function () {
  var connect = this
  if (connect.destroyed) return
  connect.work.createAnswer(connect.answerOptions).then(function (answer) {
    if (connect.destroyed) return
    answer.sdp = filterTrickle(answer.sdp)
    answer.sdp = connect.sdpTransform(answer.sdp)
    connect.work.setLocalDescription(answer).then(onSuccess).catch(onError)

    function onSuccess () {
      if (connect.destroyed) return
      if (connect.modify || connect.iceComplete) sendAnswer()
      else connect.once('iceComplete', sendAnswer)
    }

    function onError (error) {
      connect.destroy(errorMessage(error, 'ERR_SET_LOCAL_DESCRIPTION'))
    }

    function sendAnswer () {
      if (connect.destroyed) return
      var signal = connect.work.localDescription || answer
      connect.process('signal')
      connect.emit('signal', {
        type: signal.type,
        sdp: signal.sdp
      })
      if (!connect.init) connect._requestMissingTransceivers()
    }
  }).catch(function (error) { connect.destroy(errorMessage(error, 'ERR_CREATE_ANSWER')) })
}

Peer.prototype._onIceStateChange = function () {
  var connect = this
  if (connect.destroyed) return
  var iceConnectionState = connect.work.iceConnectionState
  var iceGatheringState = connect.work.iceGatheringState
  connect.process(
    'iceStateChange (connection: %s) (gathering: %s)',
    iceConnectionState,
    iceGatheringState
  )
  connect.emit('iceStateChange', iceConnectionState, iceGatheringState)
  if (iceConnectionState === 'connected' || iceConnectionState === 'completed') {
    connect.standby = true
    connect._checkForReady()
  }
  if (iceConnectionState === 'failed') {
    connect.destroy(errorMessage('Ice connection failed.', 'ERR_ICE_CONNECTION_FAILURE'))
  }
  if (iceConnectionState === 'closed') {
    connect.destroy(errorMessage('Ice connection closed.', 'ERR_ICE_CONNECTION_CLOSED'))
  }
}

Peer.prototype.getStats = function (cb) {
  var connect = this
  if (connect.work.getStats.length === 0) {
    connect.work.getStats().then(function (res) {
      
      var reports = []
      res.forEach(function (report) {
        reports.push(flattenValues(report))
      })
      cb(null, reports)
    }, function (error) { cb(error) })
  } else if (connect._isReactNativeWebrtc) {
    connect.work.getStats(null, function (res) {
      
      var reports = []
      res.forEach(function (report) {
        reports.push(flattenValues(report))
      })
      cb(null, reports)
    }, function (error) { cb(error) })

  } else if (connect.work.getStats.length > 0) {
    connect.work.getStats(function (res) {
      if (connect.destroyed) return
     
      var reports = []
      res.result().forEach(function (result) {
        
        var report = {}
        result.names().forEach(function (name) {
          report[name] = result.stat(name)
        })
        report.id = result.id
        report.type = result.type
        report.timestamp = result.timestamp
        reports.push(flattenValues(report))
      })
      cb(null, reports)
    }, function (error) { cb(error) })
  } else {
    cb(null, [])
  }

  function flattenValues (report) {
    if (Object.prototype.toString.call(report.values) === '[object Array]') {
      report.values.forEach(function (value) {
        Object.assign(report, value)
      })
    }
    return report
  }
}

Peer.prototype._checkForReady = function () {
  var connect = this
  connect.process('maybeReady pc %s channel %s', connect.standby, connect.channelReady)
  if (connect.connected || connect.connecting || !connect.standby || !connect.channelReady) return
  connect.connecting = true
  function findCandidatePair () {
    if (connect.destroyed) return
    connect.getStats(function (error, items) {
      if (connect.destroyed) return
      if (error) items = []
      
      var remoteCandidates = {}
      var localCandidates = {}
      var candidatePairs = {}
      var foundSelectedCandidatePair = false
      items.forEach(function (item) {
        if (item.type === 'remotecandidate' || item.type === 'remote-candidate') {
          remoteCandidates[item.id] = item
        }
        if (item.type === 'localcandidate' || item.type === 'local-candidate') {
          localCandidates[item.id] = item
        }
        if (item.type === 'candidatepair' || item.type === 'candidate-pair') {
          candidatePairs[item.id] = item
        }
      })

      items.forEach(function (item) {
        if (item.type === 'transport' && item.selectedCandidatePairId) {
          setSelectedCandidatePair(candidatePairs[item.selectedCandidatePairId])
        }
        if (
          (item.type === 'googCandidatePair' && item.googActiveConnection === 'true') ||
          ((item.type === 'candidatepair' || item.type === 'candidate-pair') && item.selected)
        ) {
          setSelectedCandidatePair(item)
        }
      })

      function setSelectedCandidatePair (selectedCandidatePair) {
        foundSelectedCandidatePair = true
       
        var local = localCandidates[selectedCandidatePair.localCandidateId]
        if (local && (local.ip || local.address)) { 
          connect.localAddress = local.ip || local.address
          connect.localPort = Number(local.port)
        } else if (local && local.ipAddress) { 
          connect.localAddress = local.ipAddress
          connect.localPort = Number(local.portNumber)
        } else if (typeof selectedCandidatePair.googLocalAddress === 'string') {
          local = selectedCandidatePair.googLocalAddress.split(':')
          connect.localAddress = local[0]
          connect.localPort = Number(local[1])
        }
        if (connect.localAddress) {
          connect.localFamily = connect.localAddress.includes(':') ? 'IPv6' : 'IPv4'
        }

        var remote = remoteCandidates[selectedCandidatePair.remoteCandidateId]
        if (remote && (remote.ip || remote.address)) {
          connect.remoteAddress = remote.ip || remote.address
          connect.remotePort = Number(remote.port)
        } else if (remote && remote.ipAddress) {
          connect.remoteAddress = remote.ipAddress
          connect.remotePort = Number(remote.portNumber)
        } else if (typeof selectedCandidatePair.googRemoteAddress === 'string') {
          remote = selectedCandidatePair.googRemoteAddress.split(':')
          connect.remoteAddress = remote[0]
          connect.remotePort = Number(remote[1])
        }
        if (connect.remoteAddress) {
          connect.remoteFamily = connect.remoteAddress.includes(':') ? 'IPv6' : 'IPv4'
        }
        connect.process(
          'connect local: %s:%s remote: %s:%s',
          connect.localAddress, connect.localPort, connect.remoteAddress, connect.remotePort
        )
      }
      if (!foundSelectedCandidatePair && (!Object.keys(candidatePairs).length || Object.keys(localCandidates).length)) {
        setTimeout(findCandidatePair, 100)
        return
      } else {
        connect.connecting = false
        connect.connected = true
      }
      if (connect.chunk) {
        try {
          connect.send(connect.chunk)
        } catch (error) {
          return connect.destroy(errorMessage(error, 'ERR_DATA_CHANNEL'))
        }
        connect.chunk = null
        connect.process('sent chunk from "write before connect"')

        var cb = connect.cb
        connect.cb = null
        cb(null)
      }
      if (typeof connect.peerChannel.bufferedAmountLowThreshold !== 'number') {
        connect.border = setInterval(function () { connect._onInterval() }, 150)
        if (connect.border.unref) connect.border.unref()
      }
      connect.process('connect')
      connect.emit('connect')
    })
  }
  findCandidatePair()
}

Peer.prototype._onInterval = function () {
  var connect = this
  if (!connect.cb || !connect.peerChannel || connect.peerChannel.bufferedAmount > BUFFERED_AMOUNT) {
    return
  }
  connect._onChannelBufferedAmountLow()
}

Peer.prototype._onSignalingStateChange = function () {
  var connect = this
  if (connect.destroyed) return
  if (connect.work.signalingState === 'stable' && !connect.firstStable) {
    connect.isNegotiating = false
    connect.process('flushing sender queue', connect.sendersAwaitingStable)
    connect.sendersAwaitingStable.forEach(function (sender) {
      connect.work.removeTrack(sender)
      connect.queuedNegotiation = true
    })
    connect.sendersAwaitingStable = []
    if (connect.queuedNegotiation) {
      connect.process('flushing negotiation queue')
      connect.queuedNegotiation = false
      connect._needsNegotiation() 
    }
    connect.process('negotiate')
    connect.emit('negotiate')
  }
  connect.firstStable = false
  connect.process('signalingStateChange %s', connect.work.signalingState)
  connect.emit('signalingStateChange', connect.work.signalingState)
}

Peer.prototype._onIceCandidate = function (event) {
  var connect = this
  if (connect.destroyed) return
  if (event.candidate && connect.modify) {
    connect.emit('signal', {
      candidate: {
        candidate: event.candidate.candidate,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        sdpMid: event.candidate.sdpMid
      }
    })
  } else if (!event.candidate && !connect.iceComplete) {
    connect.iceComplete = true
    connect.emit('iceComplete')
  }
  if (event.candidate) {
    connect._startIceCompleteTimeout()
  }
}

Peer.prototype._onChannelMessage = function (event) {
  var connect = this
  if (connect.destroyed) return
  
  var data = event.data
  if (data instanceof ArrayBuffer) data = Buffer.from(data)
  connect.push(data)
}

Peer.prototype._onChannelBufferedAmountLow = function () {
 
  var connect = this
  if (connect.destroyed || !connect.cb) return
  connect.process('ending backpressure: bufferedAmount %d', connect.peerChannel.bufferedAmount)
  
  var cb = connect.cb
  connect.cb = null
  cb(null)
}

Peer.prototype._onChannelOpen = function () {
  var connect = this
  if (connect.connected || connect.destroyed) return
  connect.process('on channel open')
  connect.channelReady = true
  connect._checkForReady()
}

Peer.prototype._onChannelClose = function () {
  var connect = this
  if (connect.destroyed) return
  connect.process('on channel close')
  connect.destroy()
}

Peer.prototype.process = function () {
  var connect = this
  var args = [].slice.call(arguments)
  args[0] = '[' + connect._id + '] ' + args[0]
  debug.apply(null, args)
}

function filterTrickle (sdp) { 
  return sdp.replace(/a=ice-options:trickle\s\n/g, '')
}