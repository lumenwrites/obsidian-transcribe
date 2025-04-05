import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import axios from 'axios';
import FormData from 'form-data';

interface TranscribePluginSettings {
	elevenlabsApiKey: string;
	audioFolderPath: string;
}

const DEFAULT_SETTINGS: TranscribePluginSettings = {
	elevenlabsApiKey: '',
	audioFolderPath: '_audio'
}

export default class TranscribePlugin extends Plugin {
	settings: TranscribePluginSettings;

	async onload() {
		await this.loadSettings();

		// Add "Transcribe audio" command
		this.addCommand({
			id: 'transcribe-audio',
			name: 'Transcribe audio',
			callback: async () => {
				await this.transcribeAudioFiles();
			}
		});

		// Add settings tab
		this.addSettingTab(new TranscribeSettingTab(this.app, this));
	}

	onunload() {
		// Nothing specific to clean up
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Transcribe audio files in the specified folder
	 */
	async transcribeAudioFiles() {
		try {
			if (!this.settings.elevenlabsApiKey) {
				new Notice('ElevenLabs API key is not set. Please set it in the plugin settings.');
				return;
			}

			const folderPath = this.settings.audioFolderPath;
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			
			if (!folder || !(folder instanceof TFolder)) {
				new Notice(`Folder "${folderPath}" not found. Please check your settings.`);
				return;
			}

			// Get all mp3 files in the folder
			const audioFiles = folder.children.filter(file => 
				file instanceof TFile && file.extension === 'mp3'
			) as TFile[];

			if (audioFiles.length === 0) {
				new Notice('No audio files found in the specified folder.');
				return;
			}

			// Check which files don't have a corresponding transcription
			const untranscribedFiles = audioFiles.filter(file => {
				const baseName = file.basename;
				const transcriptionPath = `${folderPath}/${baseName}-transcribed.md`;
				return !this.app.vault.getAbstractFileByPath(transcriptionPath);
			});

			if (untranscribedFiles.length === 0) {
				new Notice('All audio files have already been transcribed.');
				return;
			}

			new Notice(`Found ${untranscribedFiles.length} files to transcribe. Starting transcription...`);

			// Process each untranscribed file
			for (const file of untranscribedFiles) {
				new Notice(`Transcribing ${file.name}...`);
				
				try {
					// Read file as array buffer using Obsidian API
					const arrayBuffer = await this.app.vault.readBinary(file);
					
					// Convert array buffer to buffer
					const fileBuffer = Buffer.from(arrayBuffer);
					
					// Send to ElevenLabs for transcription
					const transcription = await this.sendToElevenLabsForTranscription(fileBuffer);
					
					// Save the transcription
					const transcriptionPath = `${folderPath}/${file.basename}-transcribed.md`;
					await this.app.vault.create(transcriptionPath, transcription);
					
					new Notice(`Transcribed ${file.name} successfully!`);
				} catch (error) {
					console.error(`Error transcribing ${file.name}:`, error);
					new Notice(`Failed to transcribe ${file.name}. Check console for details.`);
				}
			}

			new Notice('Transcription process completed.');
		} catch (error) {
			console.error('Error in transcription process:', error);
			new Notice('Error in transcription process. Check console for details.');
		}
	}

	/**
	 * Send an audio file to ElevenLabs for transcription
	 */
	async sendToElevenLabsForTranscription(fileBuffer: Buffer): Promise<string> {
		try {
			// Create a blob from buffer
			const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });
			
			// Create form data for browser environment
			const form = new FormData();
			form.append('file', blob, 'audio.mp3');
			form.append('model_id', 'scribe_v1');
			form.append('tag_audio_events', 'true');
			form.append('diarize', 'true');
			form.append('language_code', 'eng');

			const response = await axios.post(
				'https://api.elevenlabs.io/v1/speech-to-text',
				form,
				{
					headers: {
						'xi-api-key': this.settings.elevenlabsApiKey,
						'Accept': 'application/json',
					},
				}
			);

			if (response.status !== 200) {
				throw new Error(`ElevenLabs API returned status code ${response.status}`);
			}

			return response.data.text || '';
		} catch (error) {
			console.error('Error in ElevenLabs transcription:', error);
			throw new Error('Failed to transcribe with ElevenLabs: ' + (error.message || error));
		}
	}
}

class TranscribeSettingTab extends PluginSettingTab {
	plugin: TranscribePlugin;

	constructor(app: App, plugin: TranscribePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Transcribe Plugin Settings'});

		new Setting(containerEl)
			.setName('ElevenLabs API Key')
			.setDesc('API key for ElevenLabs speech-to-text service')
			.addText(text => text
				.setPlaceholder('Enter your ElevenLabs API key')
				.setValue(this.plugin.settings.elevenlabsApiKey)
				.onChange(async (value) => {
					this.plugin.settings.elevenlabsApiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Audio Folder Path')
			.setDesc('Path to the folder containing audio files')
			.addText(text => text
				.setPlaceholder('_assets/audio')
				.setValue(this.plugin.settings.audioFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.audioFolderPath = value;
					await this.plugin.saveSettings();
				}));
	}
}
