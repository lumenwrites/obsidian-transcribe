# Obsidian Transcribe Plugin

This plugin allows you to transcribe audio files within your Obsidian vault and process the transcriptions using AI.

## Features

- Transcribe audio files (mp3) using ElevenLabs speech-to-text API
- Process transcriptions using Claude AI with custom prompts
- Create custom commands to process files with different settings

## Installation

1. Download the plugin from the Obsidian Community Plugins browser
2. Enable the plugin in Obsidian settings
3. Configure the plugin with your API keys

## Setup

1. Get an API key from [ElevenLabs](https://elevenlabs.io/)
2. Get an API key from [Anthropic (Claude)](https://www.anthropic.com/)
3. Add these keys to the plugin settings

## Usage

### Transcribing Audio Files

1. Place your audio files (mp3) in your configured audio folder (default is "_assets/audio")
2. Run the "Transcribe audio" command from the command palette
3. The plugin will transcribe all audio files without existing transcriptions
4. Transcriptions will be saved as markdown files with "-transcribed" suffix in the same folder

### Cleaning Up Transcriptions

1. Create a markdown file with your instructions for cleaning up transcriptions (default location: "_assets/custom-prompt.md")
2. Run the "Clean up the transcription" command from the command palette
3. The plugin will process all transcribed files without existing formatted versions
4. Formatted transcriptions will be saved with "-formatted" suffix in the same folder

### Custom Commands

You can create custom commands to process files with different settings:

1. Go to the plugin settings
2. Click "Add Command" button
3. Configure the command with:
   - Command name
   - Folder path
   - Input file suffix
   - Output file suffix  
   - Custom prompt path
4. The command will appear in the command palette
5. When run, it will process files with the input suffix that don't have corresponding output files
6. Processed files will be saved with the output suffix

## Example Custom Command

To turn formatted transcriptions into blog posts:

1. Create a prompt file "_assets/turn-transcription-into-blog-post-prompt.md" with instructions for Claude
2. Add a custom command with:
   - Name: "Turn the formatted transcriptions into blog posts"
   - Folder: "_assets/audio"
   - Input suffix: "-formatted"
   - Output suffix: "-post"
   - Prompt path: "_assets/turn-transcription-into-blog-post-prompt.md"
3. Run the command to process all formatted transcriptions into blog posts

## License

This project is licensed under the MIT License - see the LICENSE file for details.
