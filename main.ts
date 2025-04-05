import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import axios from 'axios';
import FormData from 'form-data';
import Anthropic from '@anthropic-ai/sdk';

// Remember to rename these classes and interfaces!

interface TranscribePluginSettings {
	elevenlabsApiKey: string;
	claudeApiKey: string;
	audioFolderPath: string;
	builtInCommands: BuiltInCommandSettings;
	commands: TranscriptionCommand[];
}

interface BuiltInCommandSettings {
	cleanupPromptPath: string;
	generatePromptPath: string;
	copyPromptPath: string;
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
	builtInCommands: {
		cleanupPromptPath: '_assets/llm-prompts/cleanup-transcript.md',
		generatePromptPath: '_assets/llm-prompts/format-transcript.md',
		copyPromptPath: '_assets/llm-prompts/format-transcript.md'
	},
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

		// Add "Generate prompt" command for active file
		this.addCommand({
			id: 'generate-prompt',
			name: 'Generate prompt from active file',
			callback: async () => {
				await this.generatePrompt();
			}
		});

		// Add "Copy prompt" command for active file
		this.addCommand({
			id: 'copy-prompt',
			name: 'Copy prompt from active file to clipboard',
			callback: async () => {
				await this.copyPromptToClipboard();
			}
		});

		// Add "Generate prompts for all transcribed files" command
		this.addCommand({
			id: 'generate-prompts-batch',
			name: 'Generate prompts for all transcribed files',
			callback: async () => {
				await this.generatePromptsForTranscribedFiles();
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
			const promptPath = this.settings.builtInCommands.cleanupPromptPath;
			
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
			const anthropic = new Anthropic({
				apiKey: this.settings.claudeApiKey,
				dangerouslyAllowBrowser: true
			});
			
			const response = await anthropic.messages.create({
				model: "claude-3-haiku-20240307",
				max_tokens: 4000,
				temperature: 0.7,
				system: "You are a helpful assistant that formats and cleans up transcriptions.",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `${promptContent}\n\nHere is the transcription to process:\n\n${transcriptionContent}`
							}
						]
					}
				]
			});
			
			// Extract the message content
			if (response && response.content && response.content.length > 0) {
				return response.content.map(item => {
					if (item.type === 'text') {
						return item.text;
					}
					return '';
				}).join('\n');
			}
			
			throw new Error('Unexpected response format from Claude API');
		} catch (error) {
			console.error('Error in Claude formatting:', error);
			throw new Error('Failed to format with Claude: ' + (error.message || error));
		}
	}

	/**
	 * Generate a prompt file by combining custom prompt with the active file
	 */
	async generatePrompt(): Promise<void> {
		try {
			// Get the active file
			const activeFile = this.app.workspace.getActiveFile();
			
			if (!activeFile) {
				new Notice('No file is currently open.');
				return;
			}
			
			// Check if custom prompt file exists
			const promptPath = this.settings.builtInCommands.generatePromptPath;
			const promptFile = this.app.vault.getAbstractFileByPath(promptPath);
			
			if (!promptFile || !(promptFile instanceof TFile)) {
				new Notice(`Prompt file "${promptPath}" not found. Please check your settings.`);
				return;
			}
			
			// Get contents of both files
			const promptContent = await this.app.vault.read(promptFile);
			const fileContent = await this.app.vault.read(activeFile);
			
			// Combine contents
			const combinedContent = `${promptContent}\n\n=====\n\n${fileContent}`;
			
			// Create new file name
			const fileDir = activeFile.parent?.path || '';
			const baseName = activeFile.basename;
			const newFileName = `${baseName}-prompt.md`;
			const newFilePath = fileDir ? `${fileDir}/${newFileName}` : newFileName;
			
			// Create or update the prompt file
			const existingFile = this.app.vault.getAbstractFileByPath(newFilePath);
			
			if (existingFile && existingFile instanceof TFile) {
				await this.app.vault.modify(existingFile, combinedContent);
				new Notice(`Updated existing prompt file: ${newFileName}`);
			} else {
				await this.app.vault.create(newFilePath, combinedContent);
				new Notice(`Generated new prompt file: ${newFileName}`);
			}
		} catch (error) {
			console.error('Error generating prompt:', error);
			new Notice('Error generating prompt. Check console for details.');
		}
	}

	/**
	 * Generate prompts for all transcribed files in the audio folder
	 */
	async generatePromptsForTranscribedFiles(): Promise<void> {
		try {
			const folderPath = this.settings.audioFolderPath;
			const promptPath = this.settings.builtInCommands.generatePromptPath;
			
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
			
			// Get all transcribed files
			const transcribedFiles = folder.children.filter(file => {
				if (!(file instanceof TFile) || file.extension !== 'md') return false;
				return file.basename.endsWith('-transcribed');
			}) as TFile[];
			
			if (transcribedFiles.length === 0) {
				new Notice('No transcribed files found.');
				return;
			}
			
			new Notice(`Found ${transcribedFiles.length} transcribed files. Generating prompts...`);
			
			// Process each transcribed file
			let successCount = 0;
			for (const file of transcribedFiles) {
				try {
					// Get the transcription content
					const fileContent = await this.app.vault.read(file);
					
					// Combine contents
					const combinedContent = `${promptContent}\n\n=====\n\n${fileContent}`;
					
					// Get base name without "-transcribed"
					const originalName = file.basename.substring(0, file.basename.length - 12);
					
					// Create the prompt file
					const promptFilePath = `${folderPath}/${originalName}-prompt.md`;
					
					// Check if prompt file already exists
					const existingPromptFile = this.app.vault.getAbstractFileByPath(promptFilePath);
					
					if (existingPromptFile && existingPromptFile instanceof TFile) {
						await this.app.vault.modify(existingPromptFile, combinedContent);
					} else {
						await this.app.vault.create(promptFilePath, combinedContent);
					}
					successCount++;
				} catch (error) {
					console.error(`Error processing ${file.name}:`, error);
					new Notice(`Failed to generate prompt for ${file.name}. Check console for details.`);
				}
			}
			
			new Notice(`Generated prompts for ${successCount} out of ${transcribedFiles.length} files.`);
		} catch (error) {
			console.error('Error in batch prompt generation:', error);
			new Notice('Error in batch prompt generation. Check console for details.');
		}
	}

	/**
	 * Copy a prompt for the active file to the clipboard instead of creating a file
	 */
	async copyPromptToClipboard(): Promise<void> {
		try {
			// Get the active file
			const activeFile = this.app.workspace.getActiveFile();
			
			if (!activeFile) {
				new Notice('No file is currently open.');
				return;
			}
			
			// Check if custom prompt file exists
			const promptPath = this.settings.builtInCommands.copyPromptPath;
			const promptFile = this.app.vault.getAbstractFileByPath(promptPath);
			
			if (!promptFile || !(promptFile instanceof TFile)) {
				new Notice(`Prompt file "${promptPath}" not found. Please check your settings.`);
				return;
			}
			
			// Get contents of both files
			const promptContent = await this.app.vault.read(promptFile);
			const fileContent = await this.app.vault.read(activeFile);
			
			// Combine contents
			const combinedContent = `${promptContent}\n\n=====\n\n${fileContent}`;
			
			// Copy to clipboard
			await navigator.clipboard.writeText(combinedContent);
			
			new Notice(`Prompt copied to clipboard from: ${activeFile.name}`);
		} catch (error) {
			console.error('Error copying prompt to clipboard:', error);
			new Notice('Error copying prompt to clipboard. Check console for details.');
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

		// Built-in commands settings section
		containerEl.createEl('h3', {text: 'Built-in Commands Settings'});
		
		new Setting(containerEl)
			.setName('Clean Up Transcription Prompt Path')
			.setDesc('Path to the prompt file for the "Clean up the transcription" command')
			.addText(text => text
				.setPlaceholder('_assets/llm-prompts/cleanup-transcript.md')
				.setValue(this.plugin.settings.builtInCommands.cleanupPromptPath)
				.onChange(async (value) => {
					this.plugin.settings.builtInCommands.cleanupPromptPath = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Generate Prompt Path')
			.setDesc('Path to the prompt file for the "Generate prompt" commands')
			.addText(text => text
				.setPlaceholder('_assets/llm-prompts/format-transcript.md')
				.setValue(this.plugin.settings.builtInCommands.generatePromptPath)
				.onChange(async (value) => {
					this.plugin.settings.builtInCommands.generatePromptPath = value;
					await this.plugin.saveSettings();
				}));
				
		new Setting(containerEl)
			.setName('Copy Prompt Path')
			.setDesc('Path to the prompt file for the "Copy prompt" command')
			.addText(text => text
				.setPlaceholder('_assets/llm-prompts/format-transcript.md')
				.setValue(this.plugin.settings.builtInCommands.copyPromptPath)
				.onChange(async (value) => {
					this.plugin.settings.builtInCommands.copyPromptPath = value;
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
						promptPath: '_assets/llm-prompts/custom-prompt.md'
					});
					await this.plugin.saveSettings();
					this.display();
				}));
	}
}
