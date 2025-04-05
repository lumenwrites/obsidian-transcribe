import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import axios from 'axios';
import FormData from 'form-data';

// Remember to rename these classes and interfaces!

interface TranscribePluginSettings {
	elevenlabsApiKey: string;
	claudeApiKey: string;
	audioFolderPath: string;
	customPromptPath: string;
	commands: TranscriptionCommand[];
}

interface TranscriptionCommand {
	name: string;
	folderPath: string;
	inputSuffix: string;
	outputSuffix: string;
	promptPath: string;
}

const DEFAULT_SETTINGS: TranscribePluginSettings = {
	elevenlabsApiKey: '',
	claudeApiKey: '',
	audioFolderPath: '_assets/audio',
	customPromptPath: '_assets/custom-prompt.md',
	commands: []
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

		// Add "Clean up the transcription" command
		this.addCommand({
			id: 'clean-up-transcription',
			name: 'Clean up the transcription',
			callback: async () => {
				await this.cleanupTranscriptions();
			}
		});

		// Add custom commands based on settings
		this.settings.commands.forEach((command, index) => {
			this.addCommand({
				id: `custom-transcription-command-${index}`,
				name: command.name,
				callback: async () => {
					await this.processCustomCommand(command);
				}
			});
		});

		// Add settings tab
		this.addSettingTab(new TranscribeSettingTab(this.app, this));

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			// console.log('click', evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
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

	/**
	 * Clean up transcriptions using Claude
	 */
	async cleanupTranscriptions() {
		try {
			if (!this.settings.claudeApiKey) {
				new Notice('Claude API key is not set. Please set it in the plugin settings.');
				return;
			}

			const folderPath = this.settings.audioFolderPath;
			const promptPath = this.settings.customPromptPath;
			
			// Check if folder exists
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder || !(folder instanceof TFolder)) {
				new Notice(`Folder "${folderPath}" not found. Please check your settings.`);
				return;
			}
			
			// Check if prompt file exists
			const promptFile = this.app.vault.getAbstractFileByPath(promptPath);
			if (!promptFile || !(promptFile instanceof TFile)) {
				new Notice(`Prompt file "${promptPath}" not found. Please check your settings.`);
				return;
			}
			
			// Get the prompt content
			const promptContent = await this.app.vault.read(promptFile);
			
			// Get all transcribed files that don't have a formatted version
			const transcribedFiles = folder.children.filter(file => {
				if (!(file instanceof TFile) || file.extension !== 'md') return false;
				
				const baseName = file.basename;
				if (!baseName.endsWith('-transcribed')) return false;
				
				const originalName = baseName.substring(0, baseName.length - 12); // Remove "-transcribed"
				const formattedPath = `${folderPath}/${originalName}-formatted.md`;
				
				return !this.app.vault.getAbstractFileByPath(formattedPath);
			}) as TFile[];
			
			if (transcribedFiles.length === 0) {
				new Notice('No transcribed files found that need formatting.');
				return;
			}
			
			new Notice(`Found ${transcribedFiles.length} files to format. Starting process...`);
			
			// Process each transcribed file
			for (const file of transcribedFiles) {
				new Notice(`Formatting ${file.name}...`);
				
				try {
					// Get the transcription content
					const transcriptionContent = await this.app.vault.read(file);
					
					// Send to Claude for formatting
					const formattedText = await this.sendToClaudeForFormatting(promptContent, transcriptionContent);
					
					// Get the original name (without "-transcribed")
					const originalName = file.basename.substring(0, file.basename.length - 12); // Remove "-transcribed"
					
					// Save the formatted text
					const formattedPath = `${folderPath}/${originalName}-formatted.md`;
					await this.app.vault.create(formattedPath, formattedText);
					
					new Notice(`Formatted ${file.name} successfully!`);
				} catch (error) {
					console.error(`Error formatting ${file.name}:`, error);
					new Notice(`Failed to format ${file.name}. Check console for details.`);
				}
			}
			
			new Notice('Formatting process completed.');
		} catch (error) {
			console.error('Error in formatting process:', error);
			new Notice('Error in formatting process. Check console for details.');
		}
	}
	
	/**
	 * Process custom command
	 */
	async processCustomCommand(command: TranscriptionCommand) {
		try {
			if (!this.settings.claudeApiKey) {
				new Notice('Claude API key is not set. Please set it in the plugin settings.');
				return;
			}
			
			const folderPath = command.folderPath;
			const promptPath = command.promptPath;
			const inputSuffix = command.inputSuffix;
			const outputSuffix = command.outputSuffix;
			
			// Check if folder exists
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder || !(folder instanceof TFolder)) {
				new Notice(`Folder "${folderPath}" not found. Please check your settings.`);
				return;
			}
			
			// Check if prompt file exists
			const promptFile = this.app.vault.getAbstractFileByPath(promptPath);
			if (!promptFile || !(promptFile instanceof TFile)) {
				new Notice(`Prompt file "${promptPath}" not found. Please check your settings.`);
				return;
			}
			
			// Get the prompt content
			const promptContent = await this.app.vault.read(promptFile);
			
			// Get all input files that don't have a corresponding output version
			const inputFiles = folder.children.filter(file => {
				if (!(file instanceof TFile) || file.extension !== 'md') return false;
				
				const baseName = file.basename;
				if (!baseName.endsWith(inputSuffix)) return false;
				
				// Get the original name (without the input suffix)
				const originalNameLength = baseName.length - inputSuffix.length;
				const originalName = baseName.substring(0, originalNameLength);
				const outputPath = `${folderPath}/${originalName}${outputSuffix}.md`;
				
				return !this.app.vault.getAbstractFileByPath(outputPath);
			}) as TFile[];
			
			if (inputFiles.length === 0) {
				new Notice(`No files with suffix "${inputSuffix}" found that need processing.`);
				return;
			}
			
			new Notice(`Found ${inputFiles.length} files to process with command "${command.name}". Starting process...`);
			
			// Process each input file
			for (const file of inputFiles) {
				new Notice(`Processing ${file.name}...`);
				
				try {
					// Get the file content
					const fileContent = await this.app.vault.read(file);
					
					// Send to Claude for processing
					const processedText = await this.sendToClaudeForFormatting(promptContent, fileContent);
					
					// Get the original name (without the input suffix)
					const originalNameLength = file.basename.length - inputSuffix.length;
					const originalName = file.basename.substring(0, originalNameLength);
					
					// Save the processed text
					const outputPath = `${folderPath}/${originalName}${outputSuffix}.md`;
					await this.app.vault.create(outputPath, processedText);
					
					new Notice(`Processed ${file.name} successfully!`);
				} catch (error) {
					console.error(`Error processing ${file.name}:`, error);
					new Notice(`Failed to process ${file.name}. Check console for details.`);
				}
			}
			
			new Notice(`Command "${command.name}" completed.`);
		} catch (error) {
			console.error('Error in custom command process:', error);
			new Notice('Error in custom command process. Check console for details.');
		}
	}
	
	/**
	 * Send transcription to Claude for formatting
	 */
	async sendToClaudeForFormatting(promptContent: string, transcriptionContent: string): Promise<string> {
		try {
			const response = await axios.post(
				'https://api.anthropic.com/v1/messages',
				{
					model: 'claude-3-opus-20240229',
					max_tokens: 4000,
					messages: [
						{
							role: 'user',
							content: `${promptContent}\n\nHere is the transcription to process:\n\n${transcriptionContent}`
						}
					]
				},
				{
					headers: {
						'x-api-key': this.settings.claudeApiKey,
						'anthropic-version': '2023-06-01',
						'content-type': 'application/json'
					}
				}
			);
			
			return response.data.content[0].text;
		} catch (error) {
			console.error('Error in Claude formatting:', error);
			throw new Error('Failed to format with Claude: ' + (error.message || error));
		}
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
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
			.setName('Claude API Key')
			.setDesc('API key for Claude AI service')
			.addText(text => text
				.setPlaceholder('Enter your Claude API key')
				.setValue(this.plugin.settings.claudeApiKey)
				.onChange(async (value) => {
					this.plugin.settings.claudeApiKey = value;
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

		new Setting(containerEl)
			.setName('Custom Prompt Path')
			.setDesc('Path to the custom prompt file for transcription cleanup')
			.addText(text => text
				.setPlaceholder('_assets/custom-prompt.md')
				.setValue(this.plugin.settings.customPromptPath)
				.onChange(async (value) => {
					this.plugin.settings.customPromptPath = value;
					await this.plugin.saveSettings();
				}));
			
		// Custom commands section
		containerEl.createEl('h3', {text: 'Custom Commands'});
		
		// Display existing commands
		this.plugin.settings.commands.forEach((command, index) => {
			const commandSettingContainer = containerEl.createDiv();
			commandSettingContainer.addClass('custom-command-container');
			
			commandSettingContainer.createEl('h4', {text: `Command: ${command.name}`});
			
			new Setting(commandSettingContainer)
				.setName('Command Name')
				.addText(text => text
					.setValue(command.name)
					.onChange(async (value) => {
						this.plugin.settings.commands[index].name = value;
						await this.plugin.saveSettings();
					}));
					
			new Setting(commandSettingContainer)
				.setName('Folder Path')
				.addText(text => text
					.setValue(command.folderPath)
					.onChange(async (value) => {
						this.plugin.settings.commands[index].folderPath = value;
						await this.plugin.saveSettings();
					}));
					
			new Setting(commandSettingContainer)
				.setName('Input Suffix')
				.addText(text => text
					.setValue(command.inputSuffix)
					.onChange(async (value) => {
						this.plugin.settings.commands[index].inputSuffix = value;
						await this.plugin.saveSettings();
					}));
					
			new Setting(commandSettingContainer)
				.setName('Output Suffix')
				.addText(text => text
					.setValue(command.outputSuffix)
					.onChange(async (value) => {
						this.plugin.settings.commands[index].outputSuffix = value;
						await this.plugin.saveSettings();
					}));
					
			new Setting(commandSettingContainer)
				.setName('Custom Prompt Path')
				.addText(text => text
					.setValue(command.promptPath)
					.onChange(async (value) => {
						this.plugin.settings.commands[index].promptPath = value;
						await this.plugin.saveSettings();
					}));
					
			// Delete button
			new Setting(commandSettingContainer)
				.addButton(button => button
					.setButtonText('Delete Command')
					.onClick(async () => {
						this.plugin.settings.commands.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					}));
					
			commandSettingContainer.createEl('hr');
		});
		
		// Add new command button
		new Setting(containerEl)
			.setName('Add Custom Command')
			.setDesc('Add a new custom command for processing transcriptions')
			.addButton(button => button
				.setButtonText('Add Command')
				.onClick(async () => {
					this.plugin.settings.commands.push({
						name: 'New Custom Command',
						folderPath: this.plugin.settings.audioFolderPath,
						inputSuffix: '-transcribed',
						outputSuffix: '-processed',
						promptPath: this.plugin.settings.customPromptPath
					});
					await this.plugin.saveSettings();
					this.display();
				}));
	}
}
