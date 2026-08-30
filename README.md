# React Passport Scanner

[![NPM Version](https://img.shields.io/npm/v/react-passport-scanner)](https://www.npmjs.com/package/react-passport-scanner)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-%E2%9C%A8-success)](https://react-passport-scanner.netlify.app)

👉 **[Try the Live Demo Here](https://react-passport-scanner.netlify.app)**

A browser-only passport/MRZ (Machine Readable Zone) OCR SDK for React using Canvas and Tesseract.js.

This library provides a drop-in React component to scan passports directly in the browser, extracting MRZ data, cross-validating it, and parsing it into structured passport information.

100% Client-Side. No backend is required, and images are never sent to a server, ensuring user privacy.

## Features

- **Local Processing**: All processing runs in the browser using Web Workers.
- **Robust Pipeline**: Includes advanced Canvas preprocessing, thresholding, and rotation testing.
- **MRZ Detection**: Detects and parses standard TD3 MRZ formats.
- **Cross-Validation**: Validates checksums and ICAO rules to ensure high accuracy.
- **Exported Utilities**: Provides underlying logic functions (`mrzDetector`, `mrzNormalizer`, etc.) if you need to build a custom UI.

## Installation

You can install this SDK via npm:

```bash
npm install react-passport-scanner
```

## Basic Usage

The SDK provides a pre-built, ready-to-use component called `PassportScanner`. It renders the scanner UI, handles image selection, processing, and displays the extracted passport JSON.

```tsx
import React from 'react';
import { PassportScanner } from 'react-passport-scanner';
import 'react-passport-scanner/style.css'; // Optional: import default styles if available

function App() {
  // This function receives the parsed passport JSON when a scan succeeds!
  const handleScan = (passportData) => {
    console.log("Successfully scanned passport:", passportData);
    
    // You can now use this data to auto-fill forms, send to your backend, etc.
    // alert(`Hello ${passportData.given_names}!`);
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>Passport Verification</h1>
      <PassportScanner onScan={handleScan} />
    </div>
  );
}

export default App;
```

## Advanced Usage (Exported Utilities)

If you prefer to build your own user interface or integrate the MRZ detection into a different pipeline, you can import the raw utility functions:

```typescript
import { 
  detectMRZCandidates,
  detectMRZFromOCR,
  normalizeMRZLine,
  reconstructTD3,
  parseTD3,
  crossValidateTD3,
  scoreMRZCandidate 
} from 'react-passport-scanner';

// Example: Using the utilities with a canvas or image source
// (Implementation details depend on your exact pipeline)
```

### Detection Pipeline Overview

The underlying pipeline does not assume the MRZ is at a fixed position. It actively searches for it:
1. Normalizes the image to a browser Canvas.
2. Searches the entire image for text-like horizontal bands.
3. Tests small rotations (-5, -3, 0, 3, 5 degrees) to handle skewed photos.
4. Uses local row-peak detection and multiple grayscale thresholds.
5. Builds and scores two-line TD3 candidates.
6. Runs Tesseract.js OCR only on the most likely candidate regions.
7. Validates strict TD3/ICAO checksum rules to ensure data accuracy.

## Development

If you're cloning this repository to contribute:

```bash
npm install
npm run dev     # Run the demo app
npm run build   # Build the SDK for production
npm run test    # Run test suite
```

## Privacy & Security

This SDK is designed with privacy in mind. Passport images and parsed information remain locally in the browser memory. Text is never written to console logs or sent over the network unless explicitly handled by the consuming application.
