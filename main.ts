import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	setIcon,
} from "obsidian";
import axios from "axios";
import FormData from "form-data";
// import Anthropic from "@anthropic-ai/sdk";

interface TranscribePluginSettings {
	elevenlabsApiKey: string;
	claudeApiKey: string;
	audioFolderPath: string;
	customPrompts: CustomPromptSettings[];
	streamingUpdateInterval: number; // ms between file updates during streaming
}

interface CustomPromptSettings {
	name: string;
	inputSuffix: string;
	outputSuffix: string;
	promptPath: string;
}

const DEFAULT_SETTINGS: TranscribePluginSettings = {
	elevenlabsApiKey: "",
	claudeApiKey: "",
	audioFolderPath: "_audio",
	streamingUpdateInterval: 500,
	customPrompts: [
		{
			name: "Clean up the transcription",
			inputSuffix: "-transcribed",
			outputSuffix: "-formatted",
			promptPath: "_assets/llm-prompts/cleanup-transcript.md",
		},
	],
};

export default class TranscribePlugin extends Plugin {
	settings: TranscribePluginSettings;
	statusBarItem: HTMLElement;
	isStreaming = false;

	async onload() {
		await this.loadSettings();

		// Create status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText("");

		// Add "Transcribe audio" command
		this.addCommand({
			id: "transcribe-audio",
			name: "Transcribe audio",
			callback: async () => {
				await this.transcribeAudioFiles();
			},
		});

		// Register commands for each custom prompt
		this.registerCustomPromptCommands();

		// Add settings tab
		this.addSettingTab(new TranscribeSettingTab(this.app, this));
	}

	onunload() {
		// Clean up
		if (this.statusBarItem) {
			this.statusBarItem.remove();
		}
	}

	/**
	 * Register commands for all custom prompts
	 */
	registerCustomPromptCommands() {
		// Register commands for each custom prompt
		this.settings.customPrompts.forEach((prompt) => {
			// Command to send to Claude
			this.addCommand({
				id: `send-to-claude-${prompt.name
					.toLowerCase()
					.replace(/\s+/g, "-")}`,
				name: `${prompt.name} - Send to Claude`,
				callback: async () => {
					await this.sendActiveFileToClaudeWithPrompt(prompt);
				},
			});

			// Command to copy prompt to clipboard
			this.addCommand({
				id: `copy-prompt-${prompt.name
					.toLowerCase()
					.replace(/\s+/g, "-")}`,
				name: `${prompt.name} - Copy Prompt`,
				callback: async () => {
					await this.copyPromptToClipboard(prompt);
				},
			});
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);

		// Inform user that they need to reload Obsidian for changes to take effect
		new Notice(
			"Settings saved. Please reload Obsidian for changes to take effect."
		);
	}

	/**
	 * Transcribe audio files in the specified folder
	 */
	async transcribeAudioFiles() {
		try {
			if (!this.settings.elevenlabsApiKey) {
				new Notice(
					"ElevenLabs API key is not set. Please set it in the plugin settings."
				);
				return;
			}

			const folderPath = this.settings.audioFolderPath;
			const folder = this.app.vault.getAbstractFileByPath(folderPath);

			if (!folder || !(folder instanceof TFolder)) {
				new Notice(
					`Folder "${folderPath}" not found. Please check your settings.`
				);
				return;
			}

			// Get all mp3 files in the folder
			const audioFiles = folder.children.filter(
				(file) => file instanceof TFile && file.extension === "mp3"
			) as TFile[];

			if (audioFiles.length === 0) {
				new Notice("No audio files found in the specified folder.");
				return;
			}

			// Check which files don't have a corresponding transcription
			const untranscribedFiles = audioFiles.filter((file) => {
				const baseName = file.basename;
				const transcriptionPath = `${folderPath}/${baseName}-transcribed.md`;
				return !this.app.vault.getAbstractFileByPath(transcriptionPath);
			});

			if (untranscribedFiles.length === 0) {
				new Notice("All audio files have already been transcribed.");
				return;
			}

			new Notice(
				`Found ${untranscribedFiles.length} files to transcribe. Starting transcription...`
			);

			// Process each untranscribed file
			for (const file of untranscribedFiles) {
				new Notice(`Transcribing ${file.name}...`);

				try {
					// Read file as array buffer using Obsidian API
					const arrayBuffer = await this.app.vault.readBinary(file);

					// Convert array buffer to buffer
					const fileBuffer = Buffer.from(arrayBuffer);

					// Send to ElevenLabs for transcription
					const transcription =
						await this.sendToElevenLabsForTranscription(fileBuffer);

					// Save the transcription
					const transcriptionPath = `${folderPath}/${file.basename}-transcribed.md`;
					await this.app.vault.create(
						transcriptionPath,
						transcription
					);

					new Notice(`Transcribed ${file.name} successfully!`);
				} catch (error) {
					console.error(`Error transcribing ${file.name}:`, error);
					new Notice(
						`Failed to transcribe ${file.name}. Check console for details.`
					);
				}
			}

			new Notice("Transcription process completed.");
		} catch (error) {
			console.error("Error in transcription process:", error);
			new Notice(
				"Error in transcription process. Check console for details."
			);
		}
	}

	/**
	 * Send an audio file to ElevenLabs for transcription
	 */
	async sendToElevenLabsForTranscription(
		fileBuffer: Buffer
	): Promise<string> {
		try {
			// Create a blob from buffer
			const blob = new Blob([fileBuffer], { type: "audio/mpeg" });

			// Create form data for browser environment
			const form = new FormData();
			form.append("file", blob, "audio.mp3");
			form.append("model_id", "scribe_v1");
			form.append("tag_audio_events", "true");
			form.append("diarize", "true");
			form.append("language_code", "eng");

			const response = await axios.post(
				"https://api.elevenlabs.io/v1/speech-to-text",
				form,
				{
					headers: {
						"xi-api-key": this.settings.elevenlabsApiKey,
						Accept: "application/json",
					},
				}
			);

			if (response.status !== 200) {
				throw new Error(
					`ElevenLabs API returned status code ${response.status}`
				);
			}

			return response.data.text || "";
		} catch (error) {
			console.error("Error in ElevenLabs transcription:", error);
			throw new Error(
				"Failed to transcribe with ElevenLabs: " +
					(error.message || error)
			);
		}
	}

	/**
	 * Generate prompt by combining prompt file and active file content
	 * @returns Object containing the combined prompt and output file path
	 */
	async generatePrompt(
		promptSettings: CustomPromptSettings
	): Promise<{ combinedContent: string; outputFilePath: string } | null> {
		// Get active file
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file is open.");
			return null;
		}

		// Get prompt and file content
		const promptFile = this.app.vault.getAbstractFileByPath(
			promptSettings.promptPath
		);
		if (!promptFile || !(promptFile instanceof TFile)) {
			new Notice(`Prompt file "${promptSettings.promptPath}" not found.`);
			return null;
		}

		const promptContent = await this.app.vault.read(promptFile);
		const fileContent = await this.app.vault.read(activeFile);

		// Combine prompt and file content
		const combinedContent = `${promptContent}\n\n---\n\n${fileContent}`;

		// Calculate output file path
		let outputFileName: string;

		// If file already has the input suffix, replace it with output suffix
		if (activeFile.basename.endsWith(promptSettings.inputSuffix)) {
			outputFileName = activeFile.basename.replace(
				promptSettings.inputSuffix,
				promptSettings.outputSuffix
			);
		} else {
			// Otherwise, just append the output suffix
			outputFileName = `${activeFile.basename}${promptSettings.outputSuffix}`;
		}

		const outputFilePath = `${
			activeFile.parent?.path || ""
		}/${outputFileName}.md`;

		return { combinedContent, outputFilePath };
	}

	/**
	 * Send active file to Claude with the specified prompt
	 */
	// async sendActiveFileToClaudeWithPrompt(
	// 	promptSettings: CustomPromptSettings
	// ) {
	// 	try {
	// 		if (!this.settings.claudeApiKey) {
	// 			new Notice(
	// 				"Claude API key is not set. Please set it in the plugin settings."
	// 			);
	// 			return;
	// 		}

	// 		const result = await this.generatePrompt(promptSettings);
	// 		if (!result) return;

	// 		// Create an empty output file first
	// 		await this.app.vault.create(result.outputFilePath, "");
	// 		const outputFile = this.app.vault.getAbstractFileByPath(
	// 			result.outputFilePath
	// 		) as TFile;

	// 		if (!outputFile) {
	// 			new Notice("Failed to create output file.");
	// 			return;
	// 		}

	// 		// Set streaming status
	// 		this.isStreaming = true;
	// 		this.statusBarItem.setText("Streaming from Claude...");
	// 		setIcon(this.statusBarItem, "loader");
	// 		this.statusBarItem.addClass("is-active");

	// 		// Send to Claude
	// 		new Notice("Sending to Claude and streaming response...");

	// 		// Modify sendToClaudeAPI to accept callbacks for streaming updates
	// 		const anthropic = new Anthropic({
	// 			apiKey: this.settings.claudeApiKey,
	// 			dangerouslyAllowBrowser: true,
	// 		});

	// 		let responseText = "";
	// 		let lastUpdateTime = Date.now();
	// 		const updateInterval = this.settings.streamingUpdateInterval;
	// 		let tokenCount = 0;

	// 		// Use streaming API directly here for more control
	// 		await anthropic.messages
	// 			.stream({
	// 				model: "claude-3-7-sonnet-20250219",
	// 				max_tokens: 50000,
	// 				temperature: 0.5,
	// 				messages: [
	// 					{
	// 						role: "user",
	// 						content: result.combinedContent,
	// 					},
	// 				],
	// 			})
	// 			.on("text", async (text) => {
	// 				// Accumulate text chunks
	// 				responseText += text;
	// 				tokenCount += text.split(/\s+/).length;

	// 				// Update status bar with token count
	// 				this.statusBarItem.setText(
	// 					`Streaming from Claude: ~${tokenCount} tokens`
	// 				);

	// 				// Update file periodically to avoid too many writes
	// 				const currentTime = Date.now();
	// 				if (currentTime - lastUpdateTime > updateInterval) {
	// 					await this.app.vault.modify(outputFile, responseText);
	// 					lastUpdateTime = currentTime;
	// 				}
	// 			})
	// 			.on("error", (error) => {
	// 				console.error("Error in Claude API streaming:", error);
	// 				new Notice(
	// 					"Error in Claude processing. Check console for details."
	// 				);
	// 				// Reset streaming status
	// 				this.isStreaming = false;
	// 				this.statusBarItem.setText("");
	// 				this.statusBarItem.removeClass("is-active");
	// 			})
	// 			.on("end", async () => {
	// 				// Make sure the final content is written to file
	// 				await this.app.vault.modify(outputFile, responseText);
	// 				new Notice("Response from Claude completed!");

	// 				// Reset streaming status
	// 				this.isStreaming = false;
	// 				this.statusBarItem.setText("");
	// 				this.statusBarItem.removeClass("is-active");
	// 			});
	// 	} catch (error) {
	// 		console.error("Error in Claude processing:", error);
	// 		new Notice(
	// 			"Error in Claude processing. Check console for details."
	// 		);

	// 		// Reset streaming status
	// 		this.isStreaming = false;
	// 		this.statusBarItem.setText("");
	// 		this.statusBarItem.removeClass("is-active");
	// 	}
	// }

	/**
	 * Copy the prompt and active file content to clipboard
	 */
	async copyPromptToClipboard(promptSettings: CustomPromptSettings) {
		try {
			const result = await this.generatePrompt(promptSettings);
			if (!result) return;

			// Copy to clipboard
			await navigator.clipboard.writeText(result.combinedContent);

			new Notice("Prompt and file content copied to clipboard!");
		} catch (error) {
			console.error("Error copying to clipboard:", error);
			new Notice(
				"Error copying to clipboard. Check console for details."
			);
		}
	}

	async sendActiveFileToClaudeWithPrompt(
		promptSettings: CustomPromptSettings
	) {
		try {
			if (!this.settings.claudeApiKey) {
				new Notice(
					"Claude API key is not set. Please set it in the plugin settings."
				);
				return;
			}

			const result = await this.generatePrompt(promptSettings);
			if (!result) return;

			// Create an empty output file first
			await this.app.vault.create(result.outputFilePath, "");
			const outputFile = this.app.vault.getAbstractFileByPath(
				result.outputFilePath
			) as TFile;

			if (!outputFile) {
				new Notice("Failed to create output file.");
				return;
			}

			// Set streaming status
			this.isStreaming = true;
			this.statusBarItem.setText("Streaming from Claude...");
			setIcon(this.statusBarItem, "loader");
			this.statusBarItem.addClass("is-active");

			// Send to Claude via API proxy
			new Notice("Sending to Claude and streaming response...");

			// The URL of your deployed Claude API proxy
			// const proxyUrl = "https://your-proxy-url.vercel.app/api/claude";
			const proxyUrl = "http://localhost:3000/api/claude";

			let responseText = "";
			let lastUpdateTime = Date.now();
			const updateInterval = this.settings.streamingUpdateInterval;
			let tokenCount = 0;

			try {
				const response = await fetch(proxyUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "text/event-stream",
					},
					body: JSON.stringify({
						apiKey: this.settings.claudeApiKey,
						prompt: result.combinedContent,
						model: "claude-3-7-sonnet-20250219",
						max_tokens: 50000,
						temperature: 0.5,
					}),
				});

				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}

				const reader = response.body?.getReader();
				if (!reader) {
					throw new Error("Could not get response reader");
				}

				const decoder = new TextDecoder();

				while (true) {
					const { done, value } = await reader.read();

					if (done) {
						break;
					}

					const chunk = decoder.decode(value, { stream: true });
					const lines = chunk.split("\n\n");

					for (const line of lines) {
						if (line.startsWith("data: ")) {
							try {
								const data = JSON.parse(line.slice(6));

								if (data.error) {
									throw new Error(data.error);
								}

								if (data.done) {
									// Final update to the file
									await this.app.vault.modify(
										outputFile,
										responseText
									);

									// Reset streaming status
									this.isStreaming = false;
									this.statusBarItem.setText("");
									this.statusBarItem.removeClass("is-active");

									new Notice(
										"Response from Claude completed!"
									);
									return;
								}

								if (data.text) {
									// Append text and estimate tokens
									responseText += data.text;
									tokenCount += data.text.split(/\s+/).length;

									// Update status bar with token count
									this.statusBarItem.setText(
										`Streaming from Claude: ~${tokenCount} tokens`
									);

									// Update file periodically
									const currentTime = Date.now();
									if (
										currentTime - lastUpdateTime >
										updateInterval
									) {
										await this.app.vault.modify(
											outputFile,
											responseText
										);
										lastUpdateTime = currentTime;
									}
								}
							} catch (e) {
								// Skip invalid JSON
							}
						}
					}
				}

				// Make sure final content is written
				await this.app.vault.modify(outputFile, responseText);
			} catch (error) {
				console.error("Error streaming from Claude:", error);
				new Notice(
					`Error: ${
						error instanceof Error ? error.message : String(error)
					}`
				);

				// Write what we have so far
				if (responseText) {
					await this.app.vault.modify(outputFile, responseText);
				}

				// Reset streaming status
				this.isStreaming = false;
				this.statusBarItem.setText("");
				this.statusBarItem.removeClass("is-active");
			}
		} catch (error) {
			console.error("Error in Claude processing:", error);
			new Notice(
				"Error in Claude processing. Check console for details."
			);

			// Reset streaming status
			this.isStreaming = false;
			this.statusBarItem.setText("");
			this.statusBarItem.removeClass("is-active");
		}
	}
	/**
	 * Send content to Claude API
	 */
	// async sendToClaudeAPI(content: string): Promise<string> {
	// 	try {
	// 		const anthropic = new Anthropic({
	// 			apiKey: this.settings.claudeApiKey,
	// 			dangerouslyAllowBrowser: true,
	// 		});

	// 		// Create a result string to accumulate response
	// 		let responseText = "";

	// 		// Use streaming API with a promise to wait for completion
	// 		return new Promise((resolve, reject) => {
	// 			anthropic.messages.stream({
	// 				model: "claude-3-7-sonnet-20250219",
	// 				max_tokens: 50000,
	// 				temperature: 0.5,
	// 				messages: [
	// 					{
	// 						role: "user",
	// 						content: content,
	// 					},
	// 				],
	// 			}).on('text', (text) => {
	// 				// Accumulate text chunks
	// 				responseText += text;
	// 			}).on('error', (error) => {
	// 				console.error("Error in Claude API streaming:", error);
	// 				reject(new Error(
	// 					"Failed to get streaming response from Claude: " +
	// 						(error.message || error)
	// 				));
	// 			}).on('end', () => {
	// 				resolve(responseText);
	// 			});
	// 		});
	// 	} catch (error) {
	// 		console.error("Error calling Claude API:", error);
	// 		throw new Error(
	// 			"Failed to get response from Claude: " +
	// 				(error.message || error)
	// 		);
	// 	}
	// }
	async sendToClaudeAPI(content: string): Promise<string> {
		try {
			// The URL of your deployed Claude API proxy
			const proxyUrl = "https://your-proxy-url.vercel.app/api/claude";

			// Create a result string to accumulate response
			let responseText = "";

			// Fetch with streaming
			const response = await fetch(proxyUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify({
					apiKey: this.settings.claudeApiKey,
					prompt: content,
					model: "claude-3-7-sonnet-20250219",
					max_tokens: 50000,
					temperature: 0.5,
				}),
			});

			// Check if response is ok
			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			// Read the stream
			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error("Could not get response reader");
			}

			const decoder = new TextDecoder();

			// Read the stream chunks
			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					break;
				}

				// Decode the chunk
				const chunk = decoder.decode(value, { stream: true });

				// Process the SSE format
				const lines = chunk.split("\n\n");

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						try {
							const data = JSON.parse(line.slice(6));

							if (data.error) {
								throw new Error(data.error);
							}

							if (data.done) {
								// Stream is complete
								continue;
							}

							if (data.text) {
								// Append the text to our response
								responseText += data.text;
							}
						} catch (e) {
							// Skip invalid JSON
						}
					}
				}
			}

			return responseText;
		} catch (error) {
			console.error("Error calling Claude API via proxy:", error);
			throw new Error(
				"Failed to get response from Claude: " +
					(error instanceof Error ? error.message : String(error))
			);
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
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Transcribe Plugin Settings" });

		new Setting(containerEl)
			.setName("ElevenLabs API Key")
			.setDesc("API key for ElevenLabs speech-to-text service")
			.addText((text) =>
				text
					.setPlaceholder("Enter your ElevenLabs API key")
					.setValue(this.plugin.settings.elevenlabsApiKey)
					.onChange(async (value) => {
						this.plugin.settings.elevenlabsApiKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Claude API Key")
			.setDesc("API key for Anthropic Claude AI service")
			.addText((text) =>
				text
					.setPlaceholder("Enter your Claude API key")
					.setValue(this.plugin.settings.claudeApiKey)
					.onChange(async (value) => {
						this.plugin.settings.claudeApiKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Audio Folder Path")
			.setDesc("Path to the folder containing audio files")
			.addText((text) =>
				text
					.setPlaceholder("_assets/audio")
					.setValue(this.plugin.settings.audioFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.audioFolderPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Streaming Update Interval (ms)")
			.setDesc(
				"How frequently to update the file while streaming responses (in milliseconds)"
			)
			.addText((text) =>
				text
					.setPlaceholder("500")
					.setValue(
						this.plugin.settings.streamingUpdateInterval.toString()
					)
					.onChange(async (value) => {
						const parsed = parseInt(value);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.streamingUpdateInterval =
								parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		// Custom prompts section
		containerEl.createEl("h3", { text: "Prompts" });

		// Display commands
		this.plugin.settings.customPrompts.forEach((prompt, index) => {
			const commandSettingContainer = containerEl.createDiv();
			commandSettingContainer.addClass("custom-command-container");

			new Setting(commandSettingContainer)
				.setName("Command Name")
				.addText((text) =>
					text.setValue(prompt.name).onChange(async (value) => {
						this.plugin.settings.customPrompts[index].name = value;
						await this.plugin.saveSettings();
					})
				);

			new Setting(commandSettingContainer)
				.setName("Input Suffix")
				.addText((text) =>
					text
						.setValue(prompt.inputSuffix)
						.onChange(async (value) => {
							this.plugin.settings.customPrompts[
								index
							].inputSuffix = value;
							await this.plugin.saveSettings();
						})
				);

			new Setting(commandSettingContainer)
				.setName("Output Suffix")
				.addText((text) =>
					text
						.setValue(prompt.outputSuffix)
						.onChange(async (value) => {
							this.plugin.settings.customPrompts[
								index
							].outputSuffix = value;
							await this.plugin.saveSettings();
						})
				);

			new Setting(commandSettingContainer)
				.setName("Custom Prompt Path")
				.addText((text) =>
					text.setValue(prompt.promptPath).onChange(async (value) => {
						this.plugin.settings.customPrompts[index].promptPath =
							value;
						await this.plugin.saveSettings();
					})
				);

			// Delete button (not for default commands)
			if (index >= 4) {
				new Setting(commandSettingContainer).addButton((button) =>
					button.setButtonText("Delete Command").onClick(async () => {
						this.plugin.settings.customPrompts.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					})
				);
			}

			commandSettingContainer.createEl("hr");
		});

		// Add new custom prompt button
		new Setting(containerEl)
			.setName("Add New Custom Prompt")
			.setDesc("Add a new custom prompt for processing transcriptions")
			.addButton((button) =>
				button.setButtonText("Add Prompt").onClick(async () => {
					this.plugin.settings.customPrompts.push({
						name: "New Custom Prompt",
						inputSuffix: "-transcribed",
						outputSuffix: "-processed",
						promptPath: "_assets/llm-prompts/custom-prompt.md",
					});
					await this.plugin.saveSettings();
					this.display();
				})
			);
	}
}
