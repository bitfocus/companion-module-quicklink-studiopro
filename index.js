import { InstanceBase, InstanceStatus, Regex, runEntrypoint } from '@companion-module/base'
import { getActions } from './actions.js'
import { getPresets } from './presets.js'
import { getVariables } from './variables.js'
import { getFeedbacks } from './feedbacks.js'
import UpgradeScripts from './upgrades.js'

import OBSWebSocket, { EventSubscription } from 'obs-websocket-js'

import ADS1115 from 'ads1115'
import i2c from 'i2c-bus'
import  util  from 'util'
import { exec } from 'child_process';
const exec1 = util.promisify(exec);



class CRE8Instance extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

	//Companion Internal and Configuration
	async init(config) {
		this.log('debug')
		this.config = config
		this.updateStatus(InstanceStatus.Connecting)

		if (this.config.host && this.config.port) {
			this.connectCRE8()
		} else if (this.config.host && !this.config.port) {
			this.updateStatus(InstanceStatus.BadConfig, 'Missing WebSocket Server port')
		} else if (!this.config.host && this.config.port) {
			this.updateStatus(InstanceStatus.BadConfig, 'Missing WebSocket Server IP address or hostname')
		} else {
			this.updateStatus(InstanceStatus.BadConfig, 'Missing WebSocket Server connection info')
		}
		



	}

	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'Server IP / Hostname',
				width: 8,
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Server Port',
				width: 4,
				default: 4444,
				regex: Regex.PORT,
			},
			{
				type: 'textinput',
				id: 'pass',
				label: 'Server Password',
				width: 4,
			},
		]
	}

	async configUpdated(config) {
		this.config = config
		this.init(config)
	}

	async destroy() {
		this.disconnectCRE8()
		this.stopReconnectionPoll()
	}

	initVariables() {
		const variables = getVariables.bind(this)()
		this.setVariableDefinitions(variables)
	}

	initFeedbacks() {
		const feedbacks = getFeedbacks.bind(this)()
		this.setFeedbackDefinitions(feedbacks)
	}

	initPresets() {
		const presets = getPresets.bind(this)()
		this.setPresetDefinitions(presets)
	}

	initActions() {
		const actions = getActions.bind(this)()
		this.setActionDefinitions(actions)
	}

	//Utilities
	validName(name) {
		//Generate a valid name for use as a variable ID
		try {
			return name.replace(/[\W]/gi, '_')
		} catch (error) {
			this.log('debug', `Unable to generate validName for ${name}: ${error}`)
			return name
		}
	}

	formatTimecode(data) {
		//Converts milliseconds into a readable time format (hh:mm:ss)
		try {
			let formattedTime = new Date(data).toISOString().slice(11, 19)
			return formattedTime
		} catch (error) {}
	}

	roundNumber(number, decimalPlaces) {
		//Rounds a number to a specified number of decimal places
		try {
			return Number(Math.round(number + 'e' + decimalPlaces ?? 0) + 'e-' + decimalPlaces ?? 0)
		} catch (error) {
			this.log('debug', `Error rounding number ${number}: ${error}`)
			return number
		}
	}

	organizeChoices() {
		//Sort choices alphabetically
		this.sourceChoices?.sort((a, b) => a.id.localeCompare(b.id))
		this.sceneChoices?.sort((a, b) => a.id.localeCompare(b.id))
		this.textSourceList?.sort((a, b) => a.id.localeCompare(b.id))
		this.mediaSourceList?.sort((a, b) => a.id.localeCompare(b.id))
		this.filterList?.sort((a, b) => a.id.localeCompare(b.id))
		this.audioSourceList?.sort((a, b) => a.id.localeCompare(b.id))
		//Special Choices - Scenes
		this.sceneChoicesProgramPreview = [
			{ id: 'Current Scene', label: 'Current Scene' },
			{ id: 'Preview Scene', label: 'Preview Scene' },
		].concat(this.sceneChoices)
		this.sceneChoicesAnyScene = [{ id: 'anyScene', label: '<ANY SCENE>' }].concat(this.sceneChoices)
		this.sceneChoicesCustomScene = [{ id: 'customSceneName', label: '<CUSTOM SCENE NAME>' }].concat(this.sceneChoices)
		//Special Choices - Sources
		this.sourceChoicesWithScenes = this.sourceChoices.concat(this.sceneChoices)
		this.mediaSourceListCurrentMedia = [{ id: 'currentMedia', label: '<CURRENT MEDIA>' }].concat(this.mediaSourceList)
		//Default Choices
		this.sourceListDefault = this.sourceChoices?.[0] ? this.sourceChoices?.[0]?.id : ''
		this.sceneListDefault = this.sceneChoices?.[0] ? this.sceneChoices?.[0]?.id : ''
		this.filterListDefault = this.filterList?.[0] ? this.filterList?.[0]?.id : ''
		this.audioSourceListDefault = this.audioSourceList?.[0] ? this.audioSourceList?.[0]?.id : ''
		this.profileChoicesDefault = this.profileChoices?.[0] ? this.profileChoices[0].id : ''
	}

	updateActionsFeedbacksVariables() {
		this.organizeChoices()

		this.initActions()
		this.initVariables()
		this.initFeedbacks()
		this.initPresets()
		this.checkFeedbacks()
		this.runTerminalCmd('IP4.ADDRESS','ip4');
		this.runTerminalCmd('IP4.GATEWAY','gateway');
		this.runTerminalCmd('IP4.DNS','dns');
	}

	initializeStates() {
		//Basic Info
		this.scenes = []
		this.sources = {}
		this.states = {}
		this.transitions = {}
		this.profiles = {}
		this.sceneCollections = {}
		this.outputs = {}
		this.sceneItems = {}
		this.groups = {}
		//Source Types
		this.mediaSources = {}
		this.imageSources = {}
		this.textSources = {}
		this.sourceFilters = {}
		//Choices
		this.sceneChoices = []
		this.sourceChoices = []
		this.profileChoices = []
		this.sceneCollectionList = []
		this.textSourceList = []
		this.mediaSourceList = []
		this.imageSourceList = []
		this.hotkeyNames = []
		this.imageFormats = []
		this.transitionList = []
		this.monitors = []
		this.outputList = []
		this.filterList = []
		this.audioSourceList = []
		this.auxAudioList = [
			{id: "PGM", label: "PGM"},
			{id: "AUX1", label: "AUX1"},
			{id: "AUX2", label: "AUX2"},
			{id: "AUX3", label: "AUX3"},
			{id: "AUX4", label: "AUX4"},
			{id: "AUX5", label: "AUX5"},
			{id: "AUX6", label: "AUX6"},
			{id: "AUX7", label: "AUX7"},
			{id: "AUX8", label: "AUX8"}
		]
		this.dskTabChoices = []
		this.dskItemChoices = []
		//Set Initial States
		this.vendorEvent = {}
		this.states.sceneCollectionChanging = false
	
	}

	resetSceneSourceStates() {
		this.scenes = []
		this.sources = {}
		this.mediaSources = {}
		this.imageSources = {}
		this.textSources = {}
		this.sourceFilters = {}
		this.groups = {}

		this.sceneChoices = []
		this.sourceChoices = []
		this.filterList = []
		this.audioSourceList = []
		this.mediaSourceList = []
		this.textSourceList = []
		this.imageSourceList = []
		this.dskTabChoices = []
		this.dskItemChoices = []
	}

	async tbar() {
		i2c.openPromisified(1).then(async (bus) => {
			const ads1115 = await ADS1115(bus)
			// ads1115.gain = 1
			let oldvalue = 0.00;
			let invert = false;

			setInterval(async () => {
				let value = await ads1115.measure('0+GND')
				let conversion = parseFloat(((value * 1)/20500).toFixed(2));
			
				if(conversion > 1)
				{
					conversion = 1;
				}
				if(invert)
				{
					conversion = 1 - conversion;
				}

				 if(conversion != oldvalue)
				 {

					  oldvalue = conversion;
					  await this.sendRequest('SetTBarPosition', {  release: true, position: conversion })
				}

				if(conversion >= 1)
				{
					invert = !invert;
				}
				
			}, 50);
			
		  })
	}

	//CRE8 Websocket Connection
	async connectCRE8() {
		if (this.cre8) {
			await this.cre8.disconnect()
		} else {
			this.cre8 = new OBSWebSocket()
		}
		try {
			const { cre8WebSocketVersion } = await this.cre8.connect(
				`ws://${this.config.host}:${this.config.port}`,
				this.config.pass,
				{
					eventSubscriptions:
						EventSubscription.All |
						EventSubscription.InputActiveStateChanged |
						EventSubscription.InputShowStateChanged |
						EventSubscription.InputVolumeMeters |
						EventSubscription.SceneItemTransformChanged,
					rpcVersion: 1,
				}
			)
			if (cre8WebSocketVersion) {
				this.updateStatus(InstanceStatus.Ok)
				this.stopReconnectionPoll()
				this.log('info', 'Connected to StudioPro')

				//Setup Initial State Objects
				this.initializeStates()

				//Get Initial CRE8 Info
				let initialInfo = await this.cre8Info()

				if (initialInfo) {
					//Start Listeners
					this.cre8Listeners()

					//Get Project Info
					this.getStats()
					this.getRecordStatus()
					//this.getStreamStatus()
					this.startStatsPoll()

					//Build General Parameters
					this.buildProfileList()
					this.buildSceneCollectionList()

					//Build Scene Collection Parameters
					this.buildSceneTransitionList()
					this.buildSpecialInputs()
					this.buildSceneList()
					this.buildDSKTabs()
				}
			}
		} catch (error) {
			this.processWebsocketError(error)
		}
		this.tbar();
	
	}

	processWebsocketError(error) {
		if (!this.reconnectionPoll) {
			let tryReconnect = null
			if (error?.message.match(/(Server sent no subprotocol)/i)) {
				tryReconnect = false
				this.log('error', 'Failed to connect to CRE8. Please upgrade CRE8 to version 28 or above')
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Outdated websocket plugin')
			} else if (error?.message.match(/(missing an `authentication` string)/i)) {
				tryReconnect = false
				this.log(
					'error',
					`Failed to connect to CRE8. Please enter your WebSocket Server password in the module settings`
				)
			} else if (error?.message.match(/(Authentication failed)/i)) {
				tryReconnect = false
				this.log(
					'error',
					`Failed to connect to CRE8. Please ensure your WebSocket Server password is correct in the module settings`
				)
				this.updateStatus(InstanceStatus.BadConfig, 'Invalid password')
			} else if (error?.message.match(/(ECONNREFUSED)/i)) {
				tryReconnect = true
				this.log('error', `Failed to connect to CRE8. Please ensure CRE8 is open and reachable via your network`)
				this.updateStatus(InstanceStatus.ConnectionFailure)
			} else {
				tryReconnect = true
				this.log('error', `Failed to connect to CRE8 (${error.message})`)
				this.updateStatus(InstanceStatus.UnknownError)
			}
			if (tryReconnect) {
				this.startReconnectionPoll()
			}
		}
	}

	async disconnectCRE8() {
		if (this.cre8) {
			await this.cre8.disconnect()
			//Clear all active polls
			this.stopStatsPoll()
			this.stopMediaPoll()
		}
	}

	connectionLost() {
		if (!this.reconnectionPoll) {
			this.log('error', 'Connection lost to CRE8')
			this.updateStatus(InstanceStatus.Disconnected)
			this.disconnectCRE8()

			this.startReconnectionPoll()
		}
	}

	//CRE8 Websocket Listeners
	async cre8Listeners() {
		//General
		this.cre8.once('ExitStarted', () => {
			this.connectionLost()
		})
		this.cre8.on('ConnectionClosed', () => {
			this.connectionLost()
		})
		this.cre8.on('VendorEvent', (data) => {
			this.vendorEvent = data
			this.checkFeedbacks('vendorEvent')

			if (data && data.vendorName === 'downstream-keyer' && data.eventType === "dsk_updated" ){
				this.buildDSKTabs();
            }
		})
		//Config
		this.cre8.on('CurrentSceneCollectionChanging', () => {
			this.stopMediaPoll()
			this.states.sceneCollectionChanging = true
		})
		this.cre8.on('CurrentSceneCollectionChanged', (data) => {
			this.states.currentSceneCollection = data.sceneCollectionName
			this.checkFeedbacks('scene_collection_active')
			this.setVariableValues({ scene_collection: this.states.currentSceneCollection })
			this.states.sceneCollectionChanging = false
			this.resetSceneSourceStates()
			this.buildSceneList()
			this.buildDSKTabs()
			this.buildSceneTransitionList()
			this.cre8Info()
		})
		this.cre8.on('SceneCollectionListChanged', () => {
			this.buildSceneCollectionList()
		})
		this.cre8.on('CurrentProfileChanging', () => {})
		this.cre8.on('CurrentProfileChanged', (data) => {
			this.states.currentProfile = data.profileName
			this.checkFeedbacks('profile_active')
			this.setVariableValues({ profile: this.states.currentProfile })
			this.cre8Info()
		})
		this.cre8.on('ProfileListChanged', () => {
			this.buildProfileList()
		})
		//Scenes
		this.cre8.on('SceneCreated', (data) => {
			if (data?.isGroup === false && this.states.sceneCollectionChanging === false) {
				this.addScene(data.sceneName)
			}
		})
		this.cre8.on('SceneRemoved', (data) => {
			if (data?.isGroup === false && this.states.sceneCollectionChanging === false) {
				this.removeScene(data.sceneName)
			}
		})
		this.cre8.on('SceneNameChanged', (data) => {
			if (this.sceneItems[data.oldSceneName]) {
				this.sceneItems[data.sceneName] = this.sceneItems[data.oldSceneName]
				delete this.sceneItems[data.oldSceneName]
			}
			let scene = this.sceneChoices.findIndex((item) => item.id === data.oldSceneName)
			this.sceneChoices.splice(scene, 1)
			this.sceneChoices.push({ id: data.sceneName, label: data.sceneName })

			this.updateActionsFeedbacksVariables()
		})
		this.cre8.on('CurrentProgramSceneChanged', (data) => {
			this.states.programScene = data.sceneName
			this.setVariableValues({ scene_active: this.states.programScene })
			this.checkFeedbacks('scene_active')
			this.checkFeedbacks('sceneProgram')
		})
		this.cre8.on('CurrentPreviewSceneChanged', (data) => {
			this.states.previewScene = data.sceneName ?? 'None'
			this.setVariableValues({ scene_preview: this.states.previewScene })
			this.checkFeedbacks('scene_active')
			this.checkFeedbacks('scenePreview')
		})
		this.cre8.on('SceneListChanged', (data) => {
			this.scenes = data.scenes
		})
		//Inputs
		this.cre8.on('InputCreated', (data) => {})
		this.cre8.on('InputRemoved', (data) => {
			let source = this.sourceChoices.findIndex((item) => item.id == data.inputName)
			if (source > -1) {
				this.sourceChoices.splice(source, 1)
			}
			delete this.sources[data.inputName]
			this.updateActionsFeedbacksVariables()
		})
		this.cre8.on('InputNameChanged', () => {})
		this.cre8.on('InputActiveStateChanged', (data) => {
			if (this.sources[data.inputName]) {
				this.sources[data.inputName].active = data.videoActive
				this.checkFeedbacks('scene_item_active')
			} 
		})
		this.cre8.on('InputShowStateChanged', (data) => {
			if (this.sources[data.inputName]) {
				this.sources[data.inputName].videoShowing = data.videoShowing
				this.checkFeedbacks('scene_item_previewed')
			}
		})
		this.cre8.on('InputMuteStateChanged', (data) => {
			this.sources[data.inputName].inputMuted = data.inputMuted
			let name = this.sources[data.inputName].validName
			this.setVariableValues({
				[`mute_${name}`]: this.sources[data.inputName].inputMuted ? 'Muted' : 'Unmuted',
			})
			this.checkFeedbacks('audio_muted')
		})
		this.cre8.on('InputVolumeChanged', (data) => {
			this.sources[data.inputName].inputVolume = this.roundNumber(data.inputVolumeDb, 1)
			let name = this.sources[data.inputName].validName
			this.setVariableValues({ [`volume_${name}`]: this.sources[data.inputName].inputVolume + 'db' })
			this.checkFeedbacks('volume')
		})
		this.cre8.on('InputAudioBalanceChanged', (data) => {
			this.sources[data.inputName].inputAudioBalance = this.roundNumber(data.inputAudioBalance, 1)
			let name = this.sources[data.inputName].validName
			this.setVariableValues({ [`balance_${name}`]: this.sources[data.inputName].inputAudioBalance })
		})
		this.cre8.on('InputAudioSyncOffsetChanged', (data) => {
			this.sources[data.inputName].inputAudioSyncOffset = data.inputAudioSyncOffset
			let name = this.sources[data.inputName].validName
			this.setVariableValues({
				[`sync_offset_${name}`]: this.sources[data.inputName].inputAudioSyncOffset + 'ms',
			})
		})
		this.cre8.on('InputAudioTracksChanged', () => {})
		this.cre8.on('InputAudioMonitorTypeChanged', (data) => {
			this.sources[data.inputName].monitorType = data.monitorType
			let name = this.sources[data.inputName].validName
			let monitorType
			if (data.monitorType === 'CRE8_MONITORING_TYPE_MONITOR_AND_OUTPUT') {
				monitorType = 'Monitor / Output'
			} else if (data.monitorType === 'CRE8_MONITORING_TYPE_MONITOR_ONLY') {
				monitorType = 'Monitor Only'
			} else {
				monitorType = 'Off'
			}
			this.setVariableValues({ [`monitor_${name}`]: monitorType })
			this.checkFeedbacks('audio_monitor_type')
		})
		this.cre8.on('InputVolumeMeters', (data) => {
			this.updateAudioPeak(data)
		})
		this.cre8.on('InputSettingsChanged', (data) => {
			let source = data.inputName
			let settings = data.inputSettings

			this.updateInputSettings(source, settings)
		})
		//Transitions
		this.cre8.on('CurrentSceneTransitionChanged', async (data) => {
			let transition = await this.sendRequest('GetCurrentSceneTransition')

			this.states.currentTransition = data.transitionName
			this.states.transitionDuration = transition?.transitionDuration ?? '0'

			this.checkFeedbacks('transition_duration', 'current_transition')
			this.setVariableValues({
				current_transition: this.states.currentTransition,
				transition_duration: this.states.transitionDuration,
			})
		})
		this.cre8.on('CurrentSceneTransitionDurationChanged', (data) => {
			this.states.transitionDuration = data.transitionDuration ?? '0'
			this.checkFeedbacks('transition_duration')
			this.setVariableValues({ transition_duration: this.states.transitionDuration })
		})
		this.cre8.on('SceneTransitionStarted', () => {
			this.states.transitionActive = true
			this.setVariableValues({ transition_active: 'True' })
			this.checkFeedbacks('transition_active')
		})
		this.cre8.on('SceneTransitionEnded', () => {
			this.states.transitionActive = false
			this.setVariableValues({ transition_active: 'False' })
			this.checkFeedbacks('transition_active')
		})
		this.cre8.on('SceneTransitionVideoEnded', () => {})
		//Filters
		this.cre8.on('SourceFilterListReindexed', () => {})
		this.cre8.on('SourceFilterCreated', (data) => {
			this.getSourceFilters(data.sourceName)
		})
		this.cre8.on('SourceFilterRemoved', (data) => {
			this.getSourceFilters(data.sourceName)
		})
		this.cre8.on('SourceFilterNameChanged', () => {})
		this.cre8.on('SourceFilterEnableStateChanged', (data) => {
			if (this.sourceFilters[data.sourceName]) {
				let filter = this.sourceFilters[data.sourceName].findIndex((item) => item.filterName == data.filterName)
				if (filter !== undefined) {
					this.sourceFilters[data.sourceName][filter].filterEnabled = data.filterEnabled
					this.checkFeedbacks('filter_enabled')
				}
			}
		})
		//Scene Items
		this.cre8.on('SceneItemCreated', (data) => {
			if (this.states.sceneCollectionChanging === false) {
				this.buildSourceList(data.sceneName)
			}
		})
		this.cre8.on('SceneItemRemoved', (data) => {
			if (this.states.sceneCollectionChanging === false) {
				let item = this.sceneItems[data.sceneName].findIndex((item) => item.sceneItemId === data.sceneItemId)
				if (item > -1) {
					this.sceneItems[data.sceneName].splice(item, 1)
				}
			}
		})
		this.cre8.on('SceneItemListReindexed', () => {})
		this.cre8.on('SceneItemEnableStateChanged', (data) => {
			if (this.groups[data.sceneName]) {
				let sceneItem = this.groups[data.sceneName].findIndex((item) => item.sceneItemId === data.sceneItemId)
				this.groups[data.sceneName][sceneItem].sceneItemEnabled = data.sceneItemEnabled
			} else {
				let sceneItem = this.sceneItems[data.sceneName].findIndex((item) => item.sceneItemId === data.sceneItemId)
				this.sceneItems[data.sceneName][sceneItem].sceneItemEnabled = data.sceneItemEnabled
			}
			this.checkFeedbacks('scene_item_active_in_scene')
		})
		this.cre8.on('SceneItemLockStateChanged', () => {})
		this.cre8.on('SceneItemSelected', () => {})
		this.cre8.on('SceneItemTransformChanged', () => {})
		//Outputs
		this.cre8.on('StreamStateChanged', (data) => {
			this.states.streaming = data.outputActive

			this.setVariableValues({ streaming: this.states.streaming ? 'Live' : 'Off-Air' })
			this.checkFeedbacks('streaming', 'streamCongestion')
		})
		this.cre8.on('RecordStateChanged', (data) => {
			if (data.outputActive === true) {
				this.states.recording = 'Recording'
			} else {
				if (data.outputState === 'CRE8_WEBSOCKET_OUTPUT_PAUSED') {
					this.states.recording = 'Paused'
				} else {
					this.states.recording = 'Stopped'
					this.setVariableValues({ recording_timecode: '00:00:00' })
				}
			}
			if (data.outputPath) {
				this.setVariableValues({ recording_file_name: data.outputPath.match(/[^\\\/]+(?=\.[\w]+$)|[^\\\/]+$/) })
			}
			this.setVariableValues({ recording: this.states.recording })
			this.checkFeedbacks('recording')
		})
		this.cre8.on('ReplayBufferStateChanged', (data) => {
			this.states.replayBuffer = data.outputActive
			this.checkFeedbacks('replayBufferActive')
		})
		this.cre8.on('VirtualcamStateChanged', (data) => {
			this.outputs['virtualcam_output'].outputActive = data.outputActive
			this.checkFeedbacks('output_active')
		})
		this.cre8.on('ReplayBufferSaved', (data) => {
			this.setVariableValues({ replay_buffer_path: data.savedReplayPath })
		})
		//Media Inputs
		this.cre8.on('MediaInputPlaybackStarted', (data) => {
			this.states.currentMedia = data.inputName

			let name = this.sources[data.inputName].validName
			this.setVariableValues({
				current_media_name: this.states.currentMedia,
				[`media_status_${name}`]: 'Playing',
			})
		})
		this.cre8.on('MediaInputPlaybackEnded', (data) => {
			if (this.states.currentMedia == data.inputName) {
				let name = this.sources[data.inputName].validName
				this.setVariableValues({
					current_media_name: 'None',
					[`media_status_${name}`]: 'Stopped',
				})
			}
		})
		this.cre8.on('MediaInputActionTriggered', (data) => {
			if (data.mediaAction == 'CRE8_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE') {
				let name = this.sources[data.inputName].validName
				this.setVariableValues({ [`media_status_${name}`]: 'Paused' })
			}
		})
		//UI
		this.cre8.on('StudioModeStateChanged', async (data) => {
			this.states.studioMode = data.studioModeEnabled ? true : false
			this.checkFeedbacks('studioMode')

			if (this.states.studioMode) {
				let preview = await this.sendRequest('GetCurrentPreviewScene')
				this.states.previewScene = preview?.sceneName ?? 'None'
			} else {
				this.states.previewScene = 'None'
			}
			this.checkFeedbacks('studioMode', 'scenePreview')
			this.setVariableValues({ scene_preview: this.states.previewScene })
		})
	}

	//CRE8 Websocket Commands
	async sendRequest(requestType, requestData) {
		try {
			let data = await this.cre8.call(requestType, requestData)
			return data
		} catch (error) {
			this.log('debug', `Request ${requestType ?? ''} failed (${error})`)
		}
	}

	async sendBatch(batch) {
		try {
			let data = await this.cre8.callBatch(batch)

			let errors = data.filter((request) => request.requestStatus.result === false)
			if (errors.length > 0) {
				let errorMessages = errors.map((error) => error.requestStatus.comment).join(' // ')
				this.log('debug', `Partial batch request failure (${errorMessages})`)
			}

			return data
		} catch (error) {
			this.log('debug', `Batch request failed (${error})`)
		}
	}

	//Polls
	startReconnectionPoll() {
		this.stopReconnectionPoll()
		this.reconnectionPoll = setInterval(() => {
			this.connectCRE8()
		}, 5000)
	}

	stopReconnectionPoll() {
		if (this.reconnectionPoll) {
			clearInterval(this.reconnectionPoll)
			delete this.reconnectionPoll
		}
	}

	startStatsPoll() {
		this.stopStatsPoll()
		if (this.cre8) {
			this.statsPoll = setInterval(() => {
				this.getStats()
				if (this.states.streaming) {
					this.getStreamStatus()
				}
				if (this.states.recording === 'Recording') {
					this.getRecordStatus()
				}
				if (this.outputs) {
					for (let outputName in this.outputs) {
						this.getOutputStatus(outputName)
					}
				}
			}, 1000)
		}
	}

	stopStatsPoll() {
		if (this.statsPoll) {
			clearInterval(this.statsPoll)
			delete this.statsPoll
		}
	}

	startMediaPoll() {
		this.stopMediaPoll()
		this.mediaPoll = setInterval(() => {
			this.getMediaStatus()
		}, 1000)
	}

	stopMediaPoll() {
		if (this.mediaPoll) {
			clearInterval(this.mediaPoll)
			this.mediaPoll = null
		}
	}

	//General CRE8 Project Info
	async cre8Info() {
		try {
			let version = await this.sendRequest('GetVersion')
			this.states.version = version
			this.log(
				'debug',
				`CRE8 Version: ${version.cre8Version} // CRE8 Websocket Version: ${version.cre8WebSocketVersion} // Platform: ${version.platformDescription}`
			)
			version.supportedImageFormats.forEach((format) => {
				this.imageFormats.push({ id: format, label: format })
			})

			let studioMode = await this.sendRequest('GetStudioModeEnabled')
			this.states.studioMode = studioMode.studioModeEnabled ? true : false

			this.buildHotkeyList()
			this.buildOutputList()
			this.buildMonitorList()
			this.getVideoSettings()
			this.getReplayBufferStatus()
			return true
		} catch (error) {
			this.log('debug', error)
			return false
		}
	}

	async buildHotkeyList() {
		let hotkeyList = await this.sendRequest('GetHotkeyList')
		hotkeyList?.hotkeys?.forEach((hotkey) => {
			this.hotkeyNames.push({ id: hotkey, label: hotkey })
		})
		this.updateActionsFeedbacksVariables()
	}

	async buildProfileList() {
		let profiles = await this.sendRequest('GetProfileList')
		this.profileChoices = []

		this.states.currentProfile = profiles?.currentProfileName

		profiles?.profiles.forEach((profile) => {
			this.profileChoices.push({ id: profile, label: profile })
		})

		this.checkFeedbacks('profile_active')
		this.setVariableValues({ profile: this.states.currentProfile })
		this.updateActionsFeedbacksVariables()
	}

	async buildSceneCollectionList() {
		let collections = await this.sendRequest('GetSceneCollectionList')
		this.sceneCollectionList = []

		this.states.currentSceneCollection = collections?.currentSceneCollectionName
		collections?.sceneCollections.forEach((sceneCollection) => {
			this.sceneCollectionList.push({ id: sceneCollection, label: sceneCollection })
		})

		this.checkFeedbacks('scene_collection_active')
		this.setVariableValues({ scene_collection: this.states.currentSceneCollection })

		this.updateActionsFeedbacksVariables()
	}

	async buildSpecialInputs() {
		let specialInputs = await this.sendRequest('GetSpecialInputs')
		if (specialInputs) {
			for (let x in specialInputs) {
				let input = specialInputs[x]

				if (input) {
					this.sources[input] = {
						sourceName: input,
						validName: this.validName(input),
					}

					if (!this.sourceChoices.find((item) => item.id === input)) {
						this.sourceChoices.push({ id: input, label: input })
					}
					this.getAudioSources(input)
				}
			}
		}
	}

	async buildOutputList() {
		this.outputs = {}
		this.outputList = []

		let outputData = await this.sendRequest('GetOutputList')

		if (outputData) {
			outputData.outputs?.forEach((output) => {
				let outputKind = output.outputKind
				if (outputKind === 'virtualcam_output') {
					this.outputList.push({ id: 'virtualcam_output', label: 'Virtual Camera' })
				} else if (
					outputKind != 'ffmpeg_muxer' &&
					outputKind != 'ffmpeg_output' &&
					outputKind != 'replay_buffer' &&
					outputKind != 'rtmp_output'
				) {
					//The above outputKinds are handled separately by other actions, so they are omitted
					this.outputList.push({ id: output.outputName, label: output.outputName })
				}
				this.getOutputStatus(output.outputName)
			})
			this.updateActionsFeedbacksVariables()
		}
	}

	async buildMonitorList() {
		let monitorList = await this.sendRequest('GetMonitorList')
		this.states.monitors = monitorList

		if (monitorList) {
			monitorList.monitors?.forEach((monitor) => {
				let monitorName = monitor.monitorName ?? `Display ${monitor.monitorIndex}`

				this.monitors.push({
					id: monitor.monitorIndex,
					label: `${monitorName} (${monitor.monitorWidth}x${monitor.monitorHeight})`,
				})
			})
		}
	}

	getStats() {
		this.cre8
			.call('GetStats')
			.then((data) => {
				this.states.stats = data

				let freeSpaceMB = this.roundNumber(data.availableDiskSpace, 0)
				let freeSpace = freeSpaceMB
				if (freeSpace > 1000) {
					freeSpace = `${this.roundNumber(freeSpace / 1000, 0)} GB`
				} else {
					freeSpace = `${this.roundNumber(freeSpace, 0)} MB`
				}

				this.setVariableValues({
					fps: this.roundNumber(data.activeFps, 2),
					render_total_frames: data.renderTotalFrames,
					render_missed_frames: data.renderSkippedFrames,
					output_total_frames: data.outputTotalFrames,
					output_skipped_frames: data.outputSkippedFrames,
					average_frame_time: this.roundNumber(data.averageFrameRenderTime, 2),
					cpu_usage: `${this.roundNumber(data.cpuUsage, 2)}%`,
					memory_usage: `${this.roundNumber(data.memoryUsage, 0)} MB`,
					free_disk_space: freeSpace,
					free_disk_space_mb: freeSpaceMB,
				})
				this.checkFeedbacks('freeDiskSpaceRemaining')
			})
			.catch((error) => {
				if (error?.message.match(/(Not connected)/i)) {
					this.connectionLost()
				}
			})
	}

	async getVideoSettings() {
		let videoSettings = await this.sendRequest('GetVideoSettings')

		if (videoSettings) {
			this.states.resolution = `${videoSettings.baseWidth}x${videoSettings.baseHeight}`
			this.states.outputResolution = `${videoSettings.outputWidth}x${videoSettings.outputHeight}`
			this.states.framerate = `${this.roundNumber(videoSettings.fpsNumerator / videoSettings.fpsDenominator, 2)} fps`
			this.setVariableValues({
				base_resolution: this.states.resolution,
				output_resolution: this.states.outputResolution,
				target_framerate: this.states.framerate,
			})
		}
	}

	//Outputs, Streams, Recordings
	async getStreamStatus() {
		let streamStatus = await this.sendRequest('GetStreamStatus')
		let streamService = await this.sendRequest('GetStreamServiceSettings')

		if (streamStatus) {
			this.states.streaming = streamStatus.outputActive
			this.states.streamingTimecode = streamStatus.outputTimecode.match(/\d\d:\d\d:\d\d/i)
			this.states.streamCongestion = streamStatus.outputCongestion

			let kbits = 0
			if (streamStatus.outputBytes > this.states.outputBytes) {
				kbits = Math.round(((streamStatus.outputBytes - this.states.outputBytes) * 8) / 1000)
				this.states.outputBytes = streamStatus.outputBytes
			} else {
				this.states.outputBytes = streamStatus.outputBytes
			}

			this.checkFeedbacks('streaming', 'streamCongestion')
			this.setVariableValues({
				streaming: streamStatus.outputActive ? 'Live' : 'Off-Air',
				stream_timecode: this.states.streamingTimecode,
				output_skipped_frames: streamStatus.outputSkippedFrames,
				output_total_frames: streamStatus.outputTotalFrames,
				kbits_per_sec: kbits,
				stream_service: streamService?.streamServiceSettings?.service ?? 'Custom',
			})
		}
	}

	async getRecordStatus() {
		let recordStatus = await this.sendRequest('GetRecordStatus')
		let recordDirectory = await this.sendRequest('GetRecordDirectory')

		if (recordStatus) {
			if (recordStatus.outputActive === true) {
				this.states.recording = 'Recording'
			} else {
				this.states.recording = recordStatus.outputPaused ? 'Paused' : 'Stopped'
			}

			this.states.recordingTimecode = recordStatus.outputTimecode.match(/\d\d:\d\d:\d\d/i)
			this.states.recordDirectory = recordDirectory.recordDirectory

			this.checkFeedbacks('recording')
			this.setVariableValues({
				recording: this.states.recording,
				recording_timecode: this.states.recordingTimecode,
				recording_path: this.states.recordDirectory,
			})
		}
	}

	async getOutputStatus(outputName) {
		if (!this.states.sceneCollectionChanging) {
			let outputStatus = await this.sendRequest('GetOutputStatus', { outputName: outputName })
			this.outputs[outputName] = outputStatus
			this.checkFeedbacks('output_active')
		}
	}

	async getReplayBufferStatus() {
		let replayBuffer = await this.sendRequest('GetReplayBufferStatus')

		if (replayBuffer) {
			this.states.replayBuffer = replayBuffer.outputActive
			this.checkFeedbacks('replayBufferActive')
		}
	}

	//Scene Collection Specific Info
	async buildSceneList() {
		this.scenes = []
		this.sceneChoices = []

		let sceneList = await this.sendRequest('GetSceneList')

		if (sceneList) {
			this.scenes = sceneList.scenes
			this.states.previewScene = sceneList.currentPreviewSceneName ?? 'None'
			this.states.programScene = sceneList.currentProgramSceneName

			this.setVariableValues({
				scene_preview: this.states.te,
				scene_active: this.states.programScene,
			})

			this.scenes.forEach((scene) => {
				let sceneName = scene.sceneName
				this.sceneChoices.push({ id: sceneName, label: sceneName })
				this.buildSourceList(sceneName)
			})
			this.updateActionsFeedbacksVariables()
		}
	}

	async buildSourceList(sceneName) {
		let data = await this.sendRequest('GetSceneItemList', { sceneName: sceneName })

		if (data) {
			this.sceneItems[sceneName] = data.sceneItems

			let batch = []
			for (const sceneItem of data.sceneItems) {
				let sourceName = sceneItem.sourceName
				this.sources[sourceName] = sceneItem

				//Generate name that can be used as valid Variable IDs
				this.sources[sourceName].validName = this.validName(sceneItem.sourceName)

				if (!this.sourceChoices.find((item) => item.id === sourceName)) {
					this.sourceChoices.push({ id: sourceName, label: sourceName })
				}

				if (sceneItem.isGroup) {
					this.getGroupInfo(sourceName)
				}

				batch.push(
					{
						requestId: sourceName,
						requestType: 'GetSourceActive',
						requestData: { sourceName: sourceName },
					},
					{
						requestId: sourceName,
						requestType: 'GetSourceFilterList',
						requestData: { sourceName: sourceName },
					}
				)
				if (sceneItem.inputKind) {
					batch.push({
						requestId: sourceName,
						requestType: 'GetInputSettings',
						requestData: { inputName: sourceName },
					})
				}
				this.getAudioSources(sourceName)
			}

			let sourceBatch = await this.sendBatch(batch)

			if (sourceBatch) {
				for (const response of sourceBatch) {
					if (response.requestStatus.result) {
						let sourceName = response.requestId
						let type = response.requestType
						let data = response.responseData

						switch (type) {
							case 'GetSourceActive':
								this.sources[sourceName].active = data.videoActive
								this.sources[sourceName].videoShowing = data.videoShowing
								break
							case 'GetSourceFilterList':
								this.sourceFilters[sourceName] = data.filters
								if (data?.filters) {
									this.sourceFilters[sourceName] = data.filters
									data.filters.forEach((filter) => {
										if (!this.filterList.find((item) => item.id === filter.filterName)) {
											this.filterList.push({ id: filter.filterName, label: filter.filterName })
										}
									})
								}
								break
							case 'GetInputSettings':
								this.buildInputSettings(sourceName, data.inputKind, data.inputSettings)
								break
							default:
								break
						}
					}
				}
				this.checkFeedbacks('scene_item_active')
				this.updateActionsFeedbacksVariables()
			}
		}
	}

	async getGroupInfo(groupName) {
		let data = await this.sendRequest('GetGroupSceneItemList', { sceneName: groupName })
		if (data) {
			this.groups[groupName] = data.sceneItems
			data.sceneItems?.forEach(async (sceneItem) => {
				let sourceName = sceneItem.sourceName
				this.sources[sourceName] = sceneItem
				this.sources[sourceName].validName = this.validName(sourceName)

				//Flag that this source is part of a group
				this.sources[sourceName].groupedSource = true
				this.sources[sourceName].groupName = groupName

				if (!this.sourceChoices.find((item) => item.id === sourceName)) {
					this.sourceChoices.push({ id: sourceName, label: sourceName })
				}

				this.getSourceFilters(sourceName)
				this.getAudioSources(sourceName)

				if (sceneItem.inputKind) {
					let input = await this.sendRequest('GetInputSettings', { inputName: sourceName })

					if (input.inputSettings) {
						this.buildInputSettings(sourceName, sceneItem.inputKind, input.inputSettings)
						this.updateActionsFeedbacksVariables()
					}
				}
			})
			this.updateActionsFeedbacksVariables()
		}
	}

	async buildSceneTransitionList() {
		this.transitionList = []

		let sceneTransitionList = await this.sendRequest('GetSceneTransitionList')
		let currentTransition = await this.sendRequest('GetCurrentSceneTransition')

		if (sceneTransitionList) {
			sceneTransitionList.transitions?.forEach((transition) => {
				this.transitionList.push({ id: transition.transitionName, label: transition.transitionName })
			})

			this.states.currentTransition = currentTransition?.transitionName ?? 'None'
			this.states.transitionDuration = currentTransition?.transitionDuration ?? '0'

			this.checkFeedbacks('transition_duration', 'current_transition')
			this.setVariableValues({
				current_transition: this.states.currentTransition,
				transition_duration: this.states.transitionDuration,
				transition_active: 'False',
			})
		}
	}

	//Scene and Source Actions
	addScene(sceneName) {
		this.sceneChoices.push({ id: sceneName, label: sceneName })
		this.buildSourceList(sceneName)
		this.updateActionsFeedbacksVariables()
	}

	removeScene(sceneName) {
		let scene = this.sceneChoices.findIndex((item) => item.id === sceneName)
		if (scene) {
			this.sceneChoices.splice(scene, 1)
		}
		delete this.sceneItems[sceneName]
		this.updateActionsFeedbacksVariables()
	}

	//Source Info
	async getMediaStatus() {
		let batch = []
		for (const source of this.mediaSourceList) {
			let sourceName = source.id
			batch.push({
				requestId: sourceName,
				requestType: 'GetMediaInputStatus',
				requestData: { inputName: sourceName },
			})
		}

		let data = await this.sendBatch(batch)

		if (data) {
			for (const response of data) {
				if (response.requestStatus.result) {
					let sourceName = response.requestId
					let validName = this.sources[sourceName].validName ?? sourceName
					let data = response.responseData

					this.mediaSources[sourceName] = data

					let remaining = data?.mediaDuration - data?.mediaCursor
					if (remaining > 0) {
						remaining = this.formatTimecode(remaining)
					} else {
						remaining = '--:--:--'
					}

					this.mediaSources[sourceName].timeElapsed = this.formatTimecode(data.mediaCursor)
					this.mediaSources[sourceName].timeRemaining = remaining

					if (data?.mediaState) {
						switch (data?.mediaState) {
							case 'CRE8_MEDIA_STATE_PLAYING':
								this.setVariableValues({
									current_media_name: sourceName,
									current_media_time_elapsed: this.mediaSources[sourceName].timeElapsed,
									current_media_time_remaining: this.mediaSources[sourceName].timeRemaining,
									[`media_status_${validName}`]: 'Playing',
								})
								break
							case 'CRE8_MEDIA_STATE_PAUSED':
								this.setVariableValues({ [`media_status_${validName}`]: 'Paused' })
								break
							default:
								this.setVariableValues({ [`media_status_${validName}`]: 'Stopped' })
								break
						}
					}
					this.setVariableValues({
						[`media_time_elapsed_${validName}`]: this.mediaSources[sourceName].timeElapsed,
						[`media_time_remaining_${validName}`]: remaining,
					})
					this.checkFeedbacks('media_playing', 'media_source_time_remaining')
				}
			}
		}
	}

	buildInputSettings(sourceName, inputKind, inputSettings) {
		let name = this.sources[sourceName].validName ?? sourceName
		this.sources[sourceName].settings = inputSettings

		switch (inputKind) {
			case 'text_ft2_source_v2':
			case 'text_gdiplus_v2':
				//Exclude text sources that read from file, as there is no way to edit or read the text value
				if (inputSettings?.text) {
					this.textSourceList.push({ id: sourceName, label: sourceName })
					this.setVariableValues({
						[`current_text_${name}`]: inputSettings.text ?? '',
					})
				} else if (inputSettings?.from_file) {
					this.setVariableValues({
						[`current_text_${name}`]: `Text from file: ${inputSettings.text_file}`,
					})
				}
				break
			case 'ffmpeg_source':
			case 'vlc_source':
				this.mediaSourceList.push({ id: sourceName, label: sourceName })
				if (!this.mediaPoll) {
					this.startMediaPoll()
				}
				break
			case 'image_source':
				this.imageSourceList.push({ id: sourceName, label: sourceName })
				break
			default:
				break
		}
	}

	updateInputSettings(sourceName, inputSettings) {
		if (this.sources[sourceName]) {
			this.sources[sourceName].settings = inputSettings
			let name = this.sources[sourceName].validName ?? sourceName
			let inputKind = this.sources[sourceName].inputKind

			switch (inputKind) {
				case 'text_ft2_source_v2':
				case 'text_gdiplus_v2':
					//Exclude text sources that read from file, as there is no way to edit or read the text value
					if (inputSettings?.text) {
						this.setVariableValues({
							[`current_text_${name}`]: inputSettings.text ?? '',
						})
					} else if (inputSettings?.from_file) {
						this.setVariableValues({
							[`current_text_${name}`]: `Text from file: ${inputSettings.text_file}`,
						})
					}
					break
				case 'ffmpeg_source':
				case 'vlc_source':
					let file = ''
					if (inputSettings?.playlist) {
						file = inputSettings?.playlist[0]?.value?.match(/[^\\\/]+(?=\.[\w]+$)|[^\\\/]+$/)
						//Use first value in playlist until support for determining currently playing cue
					} else if (inputSettings?.local_file) {
						file = inputSettings?.local_file?.match(/[^\\\/]+(?=\.[\w]+$)|[^\\\/]+$/)
					}
					this.setVariableValues({ [`media_file_name_${name}`]: file })

					break
				case 'image_source':
					this.setVariableValues({
						[`image_file_name_${name}`]: inputSettings?.file
							? inputSettings?.file?.match(/[^\\\/]+(?=\.[\w]+$)|[^\\\/]+$/)
							: '',
					})
					break
				default:
					break
			}
		}
	}

	async getSourceFilters(sourceName) {
		let data = await this.sendRequest('GetSourceFilterList', { sourceName: sourceName })

		if (data?.filters) {
			this.sourceFilters[sourceName] = data.filters
			data.filters.forEach((filter) => {
				if (!this.filterList.find((item) => item.id === filter.filterName)) {
					this.filterList.push({ id: filter.filterName, label: filter.filterName })
					this.updateActionsFeedbacksVariables()
				}
			})
		}
	}

	//Audio Sources
	getAudioSources(sourceName) {
		this.cre8
			.call('GetInputAudioTracks', { inputName: sourceName })
			.then((data) => {
				if (!this.audioSourceList.find((item) => item.id === sourceName)) {
					this.audioSourceList.push({ id: sourceName, label: sourceName })
					this.sources[sourceName].inputAudioTracks = data.inputAudioTracks
					this.getSourceAudio(sourceName)
					this.updateActionsFeedbacksVariables()
				}
			})
			.catch((error) => {
				//Ignore, this source is not an audio source
			})
	}

	async getSourceAudio(sourceName) {
		let validName = this.validName(sourceName)

		let batch = [
			{
				requestId: sourceName,
				requestType: 'GetInputMute',
				requestData: { inputName: sourceName },
			},
			{
				requestId: sourceName,
				requestType: 'GetInputVolume',
				requestData: { inputName: sourceName },
			},
			{
				requestId: sourceName,
				requestType: 'GetInputAudioBalance',
				requestData: { inputName: sourceName },
			},
			{
				requestId: sourceName,
				requestType: 'GetInputAudioSyncOffset',
				requestData: { inputName: sourceName },
			},
			{
				requestId: sourceName,
				requestType: 'GetInputAudioMonitorType',
				requestData: { inputName: sourceName },
			},
			{
				requestId: sourceName,
				requestType: 'GetInputAudioTracks',
				requestData: { inputName: sourceName },
			},
		]

		let data = await this.sendBatch(batch)

		for (const response of data) {
			if (response.requestStatus.result && response.responseData) {
				let sourceName = response.requestId
				let type = response.requestType
				let data = response.responseData

				switch (type) {
					case 'GetInputMute':
						this.sources[sourceName].inputMuted = data.inputMuted
						break
					case 'GetInputVolume':
						this.sources[sourceName].inputVolume = this.roundNumber(data.inputVolumeDb, 1)
						break
					case 'GetInputAudioBalance':
						this.sources[sourceName].inputAudioBalance = this.roundNumber(data.inputAudioBalance, 1)
						break
					case 'GetInputAudioSyncOffset':
						this.sources[sourceName].inputAudioSyncOffset = data.inputAudioSyncOffset
						break
					case 'GetInputAudioMonitorType':
						this.sources[sourceName].monitorType = data.monitorType
						let monitorType
						if (data.monitorType === 'CRE8_MONITORING_TYPE_MONITOR_AND_OUTPUT') {
							monitorType = 'Monitor / Output'
						} else if (data.monitorType === 'CRE8_MONITORING_TYPE_MONITOR_ONLY') {
							monitorType = 'Monitor Only'
						} else {
							monitorType = 'Off'
						}
						this.setVariableValues({ [`monitor_${validName}`]: monitorType })
						break
					case 'GetInputAudioTracks':
						this.sources[sourceName].inputAudioTracks = data.inputAudioTracks
						break
					default:
						break
				}
			}
		}

		this.setVariableValues({
			[`mute_${validName}`]: this.sources[sourceName].inputMuted ? 'Muted' : 'Unmuted',
			[`volume_${validName}`]: this.sources[sourceName].inputVolume + 'dB',
			[`balance_${validName}`]: this.sources[sourceName].inputAudioBalance,
			[`sync_offset_${validName}`]: this.sources[sourceName].inputAudioSyncOffset + 'ms',
		})
		this.checkFeedbacks('audio_muted', 'volume', 'audio_monitor_type')
	}

	updateAudioPeak(data) {
		this.audioPeak = {}
		data.inputs.forEach((input) => {
			let channel = input.inputLevelsMul[0]
			if (channel) {
				let channelPeak = channel?.[1]
				let dbPeak = Math.round(20.0 * Math.log10(channelPeak))
				if (this.audioPeak && dbPeak) {
					this.audioPeak[input.inputName] = dbPeak
					this.checkFeedbacks('audioPeaking', 'audioMeter')
				}
			}
		})
	}

	//DSk tab list
	async buildDSKTabs() {
		this.dskTabChoices = []
		this.dskItemChoices = []
		
		let dskTabs = await this.sendRequest('CallVendorRequest',  {vendorName: "downstream-keyer", requestType: 'get_dsk_tabs'})
		if (dskTabs && dskTabs.responseData && dskTabs.responseData.success) {
			const tabCount = dskTabs.responseData.tabCount;
			
			for (let i = 0; i < tabCount; i ++) {
				this.dskTabChoices.push({id: (i+1), label: (i+1)});
				if (i === 0) this.buildDSKItems(i);
			}
		}

		this.updateActionsFeedbacksVariables();
	}

	async buildDSKItems(dskTabIdx) {
		let data = await this.sendRequest('CallVendorRequest', {vendorName: "downstream-keyer", requestType: 'get_dsk_items_in_tab', requestData: {'dskTabIdx': dskTabIdx}})
		
		this.dskItemChoices = []
		if (data && data.responseData && data.responseData.success && data.responseData.dskData) {
			const dskData = data.responseData.dskData;

			for (const dskItem of dskData) {
				let sceneName = dskItem.sceneName;

				if (!this.dskItemChoices.find((item) => item.id === sceneName)) {
					this.dskItemChoices.push({ id: sceneName, label: sceneName })
				}
			}
		}

		this.updateActionsFeedbacksVariables();
	}

	getAuxIdxFromName(auxName) {
		if (auxName === "PGM") return 0;
		else if (auxName === "AUX1") return 2;
		else if (auxName === "AUX2") return 3;
		else if (auxName === "AUX3") return 4;
		else if (auxName === "AUX4") return 5;
		else if (auxName === "AUX5") return 6;
		else if (auxName === "AUX6") return 7;
		else if (auxName === "AUX7") return 8;
		else if (auxName === "AUX8") return 9;

		return -1;
	}

	

	audioControlKnob(sourceIdx, direction) {
		console.log('The sourceIdx ', sourceIdx, ' direction ', direction);
		console.log('The ip 1 i ', this.getVariableValue('ip_1'));
		
		const sourceVarKeys = ['audio_control_source_1', 'audio_control_source_2', 'audio_control_source_3', 'audio_control_source_4'];
		const controlTypeVarKeys = ['audio_control_type_1', 'audio_control_type_2', 'audio_control_type_3', 'audio_control_type_4'];
		const ipVarKeys = ['ip_1', 'ip_2', 'ip_3', 'ip_4'];

		const controlTypeKey = this.getVariableValue(controlTypeVarKeys[sourceIdx]);
		const key = sourceVarKeys[sourceIdx];
		const ipkey = ipVarKeys[sourceIdx];
		console.log('The key is ', controlTypeKey );
		const audioSourceList = this.audioSourceList.concat(this.auxAudioList);

		if(controlTypeKey === 0)
		{
			let currentValue = this.getVariableValue(ipkey);
			if(currentValue > 255)
			{
				currentValue = 255;
			}
			else if(currentValue < 1)
			{
				currentValue = 1;
			} 

			this.setVariableValues({[ipkey]: parseInt(currentValue) + direction});
		


		}else if (controlTypeKey === 1) { // Source selection
			let value = this.getVariableValue(key);
			if (!value) value = "";
			if (!audioSourceList || audioSourceList.length === 0) return;
			
			let valueIndex = -1;
			for (let i = 0; i < audioSourceList.length; i ++) {
				if (value === audioSourceList[i].id) valueIndex = i;
			}
			if (valueIndex === undefined || valueIndex === null || valueIndex < 0) {
				valueIndex = 0;
			}else{
				valueIndex = valueIndex + 1 * direction;
				if (valueIndex < 0) valueIndex = audioSourceList.length - 1;
				if (valueIndex >= audioSourceList.length) valueIndex = 0;
			}

			const newValue = audioSourceList[valueIndex] ? audioSourceList[valueIndex].id : "";
			this.setVariableValues({[key]: newValue});

		}else if (controlTypeKey === 2) { // audio volume control
			const sourceName = this.getVariableValue(key);
			console.log('The sourcename is ', sourceName);
			
			if (sourceName.indexOf("AUX") >= 0 || sourceName === "PGM"){
				const trackIdx = this.getAuxIdxFromName(sourceName);
				this.sendRequest('CallVendorRequest',  {vendorName: "cre8-app-main-controls", 
					requestType: 'set_track_volume_byinc', requestData: {"track-idx": trackIdx, "increment": direction * 100}}) // 1000 --> 1, 100 --->0.1
				return;
			}

			if (sourceName){
				let newVolume = this.sources[sourceName].inputVolume + 0.1 * direction // 5 is increment/decrement of voume
				if (newVolume > 20) {
					newVolume = 20
				} else if (newVolume < -60) {
					newVolume = -60.1
				}

				this.sendRequest('SetInputVolume', { inputName: sourceName, inputVolumeDb: newVolume })
			}
		}
	}

	async toggleIP(type){
		console.log('ToggleIP');
		let settings = this.getVariableValue('ipSettings');
		console.log('The type  is ', type);
		let address = this.getVariableValue(type);
		console.log('the address is ', address);
		const ipVarKeys = ['ip_1', 'ip_2', 'ip_3', 'ip_4'];
		settings = !settings;
		this.setVariableValues({['ipSettings']:settings});

		if(settings)
		{
			//const { stdout, stderr } = await exec1('hostname -I');
			//console.log( 'the stdout is', stdout );
			let currentIP = address;
			let IP = currentIP.split('.');
			for(let i = 0;i<4;i++)
			{
				console.log('The ip key is ', ipVarKeys[i] , 'the ip number is ', IP[i])
				this.setVariableValues({[ ipVarKeys[i]]: parseInt(IP[i])});

			}
			//console.log( 'the stderr is', stderr );
		}
		else{
			for(let i = 0;i<4;i++)
			{
				console.log('Setting ip to emptystring')
				this.setVariableValues({[ ipVarKeys[i]]: ''});

			}

		}

	

	}

	updateAudioControlSourceType(key) {
		
		let value = this.getVariableValue(key);
		value ++;
		if (value > 2) value = 0;

		this.setVariableValues({[key]: value});
		this.checkFeedbacks('audio_control_type')
	}

	async updateNetworkMethod(){
		
		const { stdout, stderr } = await exec1('nmcli con show eth | grep ipv4.method');
		console.log('The method is ', stdout.split(':')[1].trim());

	}
	async setStatic(){
		
		const { stdout, stderr } = await exec1('nmcli con mod eth ipv4.method manual');
		

	}
	async setDynamic(){
		
		const { stdout, stderr } = await exec1('nmcli con mod eth ipv4.method auto');
		

	}

	async updateNetwork(type, ipsetting)
	{
		let ip1 = this.getVariableValue('ip_1');
		let ip2 = this.getVariableValue('ip_2');
		let ip3 = this.getVariableValue('ip_3');
		let ip4 = this.getVariableValue('ip_4');

		let setting = ip1 + '.' +ip2+'.'+ip3+'.'+ip4;
		console.log('the ip to set is ', setting);
		if(ipsetting == 'ip4')
		{
			setting = setting + '/24';
		}
		const { stdout, stderr } = await exec1('nmcli con mod eth ' + type + ' ' + setting);
		console.log('the response is ', stdout);
	}

	async runTerminalCmd(searchterm, setting){
		//console.log('in runcmd');
		const { stdout, stderr } = await exec1('nmcli d show eth0 | grep -i '+ searchterm);
		let value = stdout.split(':')[1].trim();
		if(setting == 'ip4')
		{
			value = value.split('/')[0];
		}
		 
			this.setVariableValues({[setting]:value});
		
		


	}
	
}
runEntrypoint(CRE8Instance, UpgradeScripts)
