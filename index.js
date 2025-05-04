const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { SpeechClient } = require("@google-cloud/speech");
const ffmpeg = require("fluent-ffmpeg");
const stream = require("stream");
const path = require("path");
const { Writable } = require("stream"); // Import Writable

// Configure credentials (Make sure the path is correct)
const credentialsPath = path.join(__dirname, "southern-frame-458507-a8-e3452fa080b5.json");

try {
  if (!require("fs").existsSync(credentialsPath)) {
    throw new Error(`Credentials file not found at: ${credentialsPath}`);
  }
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  console.log("Google credentials loaded successfully.");
} catch (error) {
  console.error("Error loading Google credentials:", error.message);
  process.exit(1); // Exit if credentials are missing
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const speechClient = new SpeechClient();

// Keep track of streams per client
const clientStreams = new Map(); // Map<WebSocket, { recognizeStream: stream, ffmpegProcess: process }>

// --- Google STT Config ---
const requestConfig = {
  config: {
    encoding: "LINEAR16",
    sampleRateHertz: 16000,
    languageCode: "en-US", // Change if needed
    model: 'default', 
    useEnhanced: true, // Use enhanced model if available
    speechContexts: [
      {
        phrases: ['specific', 'terms', 'related', 'to', 'your', 'application'], 
      },
    ],
    enableWordTimeOffsets: true, // Optional: Get word time offsets
    enableAutomaticPunctuation: true, // Optional: Add punctuation
  },
  interimResults: true, // Get interim results for faster feedback
};

// --- WebSocket Server Logic ---
wss.on("connection", (ws) => {
  console.log("Client connected via WebSocket.");
  let recognizeStream = null;
  let ffmpegProcess = null; // To manage the ffmpeg process lifecycle

  // --- Google Speech Stream Creation ---
  const startRecognitionStream = () => {
    console.log(
      `[${
        ws.clientId || "New Client"
      }] Starting Google Speech recognize stream.`
    );
    recognizeStream = speechClient
      .streamingRecognize(requestConfig)
      .on("error", (err) => {
        console.error(`[${ws.clientId}] Google Speech API Error:`, err);
        // Attempt to close and clean up
        stopRecognitionStream();
        // Optionally notify the client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ error: `Google Speech API Error: ${err.message}` })
          );
        }
      })
      .on("data", (data) => {
        if (data.results[0]?.alternatives[0]) {
          const transcript = data.results[0].alternatives[0].transcript;
          const isFinal = data.results[0].isFinal;
          // console.log(`[${ws.clientId}] Transcription: ${transcript} (Final: ${isFinal})`); // Can be noisy

          // Send transcription back ONLY to the client that sent the audio
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ transcript, isFinal }));
          } else {
            console.warn(
              `[${ws.clientId}] WebSocket closed, cannot send transcription.`
            );
            stopRecognitionStream(); // Stop if WS is closed
          }
        } else {
          // console.log(`[${ws.clientId}] Received empty speech result.`);
        }
      })
      .on("end", () => {
        console.log(`[${ws.clientId}] Google Speech recognize stream ended.`);
        // Stream naturally ends sometimes, may need restarting if client is still active
      });

    // Store the stream associated with this client
    clientStreams.set(ws, { recognizeStream, ffmpegProcess: null }); // ffmpegProcess added later if needed
  };

  // --- Stop and Cleanup ---
  const stopRecognitionStream = () => {
    const clientData = clientStreams.get(ws);
    if (clientData) {
      if (clientData.recognizeStream) {
        console.log(`[${ws.clientId}] Destroying Google recognize stream.`);
        clientData.recognizeStream.destroy(); // Use destroy to forcefully close
      }
      if (clientData.ffmpegProcess) {
        console.log(`[${ws.clientId}] Killing ffmpeg process.`);
        clientData.ffmpegProcess.kill("SIGKILL"); // Force kill ffmpeg if it's running
      }
      clientStreams.delete(ws);
    } else {
      console.log(`[${ws.clientId}] No active stream found to stop.`);
    }
  };

  // --- Handle Incoming Messages ---
  ws.on("message", (message) => {
    // Assign a simple ID for logging if not already done
    if (!ws.clientId) {
      ws.clientId = `Client_${Date.now().toString().slice(-4)}`;
    }

    let parsedMessage;
    try {
      // Check if message is Buffer or string before parsing
      parsedMessage = JSON.parse(message.toString());
    } catch (e) {
      console.error(
        `[${ws.clientId}] Received non-JSON message or invalid JSON. Ignoring.`
      );
      // Handle binary audio data directly if you switch to that later
      return;
    }

    if (parsedMessage.type === "audio_chunk" && parsedMessage.data) {
      // Ensure stream exists, create if not (e.g., first chunk)
      if (!clientStreams.has(ws) || !clientStreams.get(ws).recognizeStream) {
        console.log(`[${ws.clientId}] No stream found, starting new one.`);
        startRecognitionStream(); // Create the stream for this client
      }

      const clientData = clientStreams.get(ws);
      if (!clientData || !clientData.recognizeStream) {
        console.error(
          `[${ws.clientId}] Failed to get or create recognizeStream. Cannot process audio.`
        );
        return;
      }

      // Decode Base64 and convert WAV buffer to raw PCM using ffmpeg
      try {
        const audioBuffer = Buffer.from(parsedMessage.data, "base64");
        console.log(
          `[${ws.clientId}] Received audio chunk (${audioBuffer.length} bytes). Converting...`
        );
        console.log(
          `[${ws.clientId}] First 16 bytes (hex):`,
          audioBuffer.slice(0, 16).toString("hex")
        );

        // Create a PassThrough stream for the input buffer
        const inputStream = new stream.PassThrough();
        inputStream.end(audioBuffer);

        // Kill previous ffmpeg process if it exists and hasn't finished
        if (clientData.ffmpegProcess) {
          console.log(
            `[${ws.clientId}] Killing previous ffmpeg process for new chunk.`
          );
          clientData.ffmpegProcess.kill("SIGKILL");
        }

        // Use ffmpeg to convert WAV buffer to raw PCM (s16le)
        // const ffmpegCommand = ffmpeg(inputStream)
        //   // --- Add this line ---
        //   .inputOption("-acodec pcm_s16le") // Explicitly tell ffmpeg the input codec is PCM S16LE
        //   // --------------------
        //   .inputFormat("wav") // Still specify the container format
        //   .outputFormat("s16le") // Google requires LINEAR16 (signed 16-bit little-endian)
        //   .audioFrequency(16000)
        //   .audioChannels(1)
        //   .on("error", (err, stdout, stderr) => {
        //     console.error(`[${ws.clientId}] Ffmpeg Error:`, err.message);
        //     // Log stderr for more clues if it fails again
        //     console.error(`[${ws.clientId}] Ffmpeg stderr:`, stderr);
        //     clientData.ffmpegProcess = null; // Clear ffmpeg process on error
        //   })
        //   .on("start", (commandLine) => {
        //     console.log(
        //       `[${ws.clientId}] Started ffmpeg process: ${commandLine}`
        //     );
        //   })
        //   .on("end", () => {
        //     console.log(`[${ws.clientId}] Ffmpeg conversion finished.`);
        //     clientData.ffmpegProcess = null; // Clear ffmpeg process on successful end
        //     // Don't end the recognizeStream here, it should stay open
        //   });

        console.log(
          `[${ws.clientId}] Attempting to process input as raw s16le PCM.`
        );
        // const ffmpegCommand = ffmpeg(inputStream)
        //   // Input options: Specify raw audio format
        //   .inputOption("-f s16le") // Format: signed 16-bit little-endian PCM
        //   .inputOption("-ar 16000") // Sample rate: 16kHz
        //   .inputOption("-ac 1") // Audio channels: 1 (mono)
        //   // Output options: Still outputting raw PCM for Google STT
        //   .outputFormat("s16le")
        //   .audioFrequency(16000)
        //   .audioChannels(1)
        //   .on("error", (err, stdout, stderr) => {
        //     console.error(
        //       `[${ws.clientId}] Ffmpeg Error (Raw PCM Mode):`,
        //       err.message
        //     );
        //     console.error(
        //       `[${ws.clientId}] Ffmpeg stderr (Raw PCM Mode):`,
        //       stderr
        //     );
        //     clientData.ffmpegProcess = null;
        //   })
        //   .on("start", (commandLine) => {
        //     // Note: command line will now look like:
        //     // ffmpeg -f s16le -ar 16000 -ac 1 -i pipe:0 -ar 16000 -ac 1 -f s16le pipe:1
        //     console.log(
        //       `[${ws.clientId}] Started ffmpeg process (Raw PCM Mode): ${commandLine}`
        //     );
        //   })
        //   .on("end", () => {
        //     console.log(
        //       `[${ws.clientId}] Ffmpeg conversion finished (Raw PCM Mode).`
        //     );
        //     clientData.ffmpegProcess = null;
        //   });

        // Replace your ffmpeg snippet with:

        const ffmpegCommand = ffmpeg(inputStream)
          // Don’t call noInputOptions(); remove that line entirely
          .inputFormat("3gp") // or remove if you want auto‐detect
          .outputOptions([
            "-acodec pcm_s16le", // decode to signed 16-bit PCM
            "-ar 16000", // resample to 16 kHz
            "-ac 1", // mono
            "-f s16le", // raw little-endian PCM
          ])
          .on("start", (cmd) => console.log(`FFmpeg start: ${cmd}`))
          .on("error", (err, stdout, stderr) => {
            console.error("FFmpeg error:", err.message);
            console.error(stderr);
          })
          .on("end", () => console.log("FFmpeg conversion finished."));

        // Pipe ffmpeg's output (raw PCM) to Google Speech stream
        // Use { end: false } so that the recognizeStream doesn't close after one chunk
        ffmpegCommand.pipe(clientData.recognizeStream, { end: false });

        // Store the ffmpeg process to potentially kill it later
        clientData.ffmpegProcess = ffmpegCommand;
      } catch (error) {
        console.error(`[${ws.clientId}] Error processing audio chunk:`, error);
      }
    } else if (parsedMessage.type === "end_audio") {
      console.log(
        `[${ws.clientId}] Received end_audio signal. Client stopped sending.`
      );
      // Optionally: You *could* end the recognizeStream here if you are sure the user
      // interaction has completely finished. But often it's better to leave it
      // open for a short timeout in case they start speaking again quickly.
      // For simplicity now, we just log it. If needed, implement a timeout later.
      // stopRecognitionStream(); // Uncomment this if you want to close stream immediately on stop
    } else {
      console.log(
        `[${ws.clientId}] Received unknown message type:`,
        parsedMessage.type
      );
    }
  });

  // --- Handle Client Disconnection ---
  ws.on("close", (code, reason) => {
    console.log(
      `[${
        ws.clientId || "Client"
      }] WebSocket connection closed. Code: ${code}, Reason: ${
        reason ? reason.toString() : "N/A"
      }`
    );
    stopRecognitionStream(); // Clean up associated streams
  });

  // --- Handle WebSocket Errors ---
  ws.on("error", (error) => {
    console.error(`[${ws.clientId || "Client"}] WebSocket error:`, error);
    stopRecognitionStream(); // Clean up on error as well
  });

  // Start the stream immediately on connection? Or wait for first audio?
  // Waiting for first audio chunk might save slight API cost if user connects but never speaks.
  // startRecognitionStream(); // <-- Start stream immediately (optional)
});

// Remove the old /upload endpoint
// app.post("/upload", ...) - DELETE THIS ENTIRE BLOCK

// Start Server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
