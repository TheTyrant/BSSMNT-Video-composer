# JS DJ Audio Visualizer

A web-based audio visualizer and processor for DJs, built with JavaScript. This project lets you visualize and manipulate audio in real time, making it perfect for live performances, music analysis, or just having fun with sound.

Performed live at [Indy Hall](https://www.indyhall.org/) in Philadelphia, driving real-time visuals off a Pioneer DDJ-REV1 in front of an audience.

## Features
- Real-time audio visualization
- Audio processing and effects
- Interactive controls for DJs
- Modern, responsive UI

## Demo

![Galaxy visualization mode reacting to audio](docs/screenshots/demo.gif)

| Spectrum Bars | Mandala |
| --- | --- |
| ![Spectrum bars mode](docs/screenshots/spectrum-bars.png) | ![Mandala mode](docs/screenshots/mandala-mode.png) |

To see the app in action yourself, clone the repo and follow the instructions below.

## Getting Started

### Prerequisites
- Node.js (for development, optional)
- A modern web browser (Chrome, Firefox, Edge, Safari)

### Installation
1. Clone the repository:
	 ```sh
	 git clone https://github.com/philaconvalley/djVisualizer.git
	 cd djVisualizer
	 ```
2. (Optional) Install dependencies if you plan to extend or build locally:
	 ```sh
	 npm install
	 ```

### Running Locally (works offline)
Everything the app needs is in this folder (`vendor/` holds the libraries and fonts), so no internet connection is needed.

- **Windows:** double-click **Start BSS MNT.bat** — it starts a small server on this computer and opens the app in your browser.
- **Any system with Node.js:** `node serve.js`, then open `http://127.0.0.1:8765`.

Use Chrome or Edge (video export and project files need them). Opening `index.html` straight from disk is not enough: browsers block the module files that saving projects and exporting video use.

## Project Structure
```
app/
	app.js              # Main application logic
	audioProcessor.js   # Audio processing and effects
	visualizer.js       # Visualization logic
styles/
	styles.css          # App styles
index.html            # Main HTML file
netlify.toml, vercel.json # Deployment configs
```

## Usage
- Upload or select an audio file
- Watch the real-time visualization
- Use controls to manipulate playback and effects

## Contributing
Contributions are welcome! Please open issues or submit pull requests for new features, bug fixes, or improvements.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/YourFeature`)
3. Commit your changes (`git commit -am 'Add new feature'`)
4. Push to the branch (`git push origin feature/YourFeature`)
5. Open a pull request

## License
MIT License. See [LICENSE](LICENSE) for details.

## Authors
- [traksaw](https://github.com/traksaw)

## Acknowledgments
- Inspired by the DJ and web audio community
- Built with the Web Audio API and Canvas
