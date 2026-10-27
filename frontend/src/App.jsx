import { useState, useEffect, useRef } from "react";
import axios from "axios";
import "./App.css";

const API_BASE = "http://127.0.0.1:8000";
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB
const CONCURRENCY = 3;

function App() {
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [files, setFiles] = useState([]);
  const abortController = useRef(null);

  // Load file list on page load
  useEffect(() => {
    fetchFiles();
  }, []);

  const fetchFiles = async () => {
    try {
      const res = await axios.get(`${API_BASE}/files`);
      setFiles(res.data.files);
    } catch (err) {
      console.error("Failed to load files", err);
    }
  };

  const handleFileChange = (e) => {
    setFile(e.target.files[0]);
    setProgress(0);
    setStatus("");
    setDownloadUrl("");
  };

  const startUpload = async () => {
    if (!file) return alert("Please select a file first");

    setIsUploading(true);
    setStatus("Initiating upload...");
    setDownloadUrl("");
    abortController.current = new AbortController();

    try {
      const initRes = await axios.post(`${API_BASE}/initiate`, {
        filename: file.name,
        content_type: file.type || "application/pdf",
      });

      const { upload_id, key } = initRes.data;
      const totalParts = Math.ceil(file.size / CHUNK_SIZE);

      const uploadState = {
        upload_id,
        key,
        filename: file.name,
        fileSize: file.size,
        totalParts,
        completedParts: {},
      };
      localStorage.setItem("multipart-upload", JSON.stringify(uploadState));

      await uploadParts(file, uploadState);
    } catch (err) {
      console.error(err);
      setStatus("Error: " + (err.response?.data?.detail || err.message));
      setIsUploading(false);
    }
  };

  const uploadParts = async (file, uploadState) => {
  const { upload_id, key, totalParts, completedParts } = uploadState;

  const partsToUpload = [];
  for (let i = 1; i <= totalParts; i++) {
    if (!completedParts[i]) {
      partsToUpload.push(i);
    }
  }

  let completedCount = Object.keys(completedParts).length;
  setStatus(`Resuming... ${completedCount}/${totalParts} parts already done`);

  const uploadOnePart = async (partNumber) => {
    const start = (partNumber - 1) * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const blob = file.slice(start, end);

    const presignRes = await axios.post(`${API_BASE}/presign-part`, {
      upload_id,
      key,
      part_number: partNumber,
    });

    const uploadRes = await axios.put(presignRes.data.url, blob, {
      headers: { "Content-Type": file.type || "application/octet-stream" },
      signal: abortController.current?.signal,
    });

    const etag = uploadRes.headers.etag?.replace(/"/g, "");
    return { partNumber, etag };
  };

  try {
    for (let i = 0; i < partsToUpload.length; i += CONCURRENCY) {
      const batch = partsToUpload.slice(i, i + CONCURRENCY);

      // Upload current batch
      const batchResults = await Promise.all(batch.map(uploadOnePart));

      // Save each successful part immediately
      batchResults.forEach(({ partNumber, etag }) => {
        if (etag) {
          completedParts[partNumber] = etag;
          completedCount++;
        }
      });

      // Save to localStorage after every batch
      localStorage.setItem(
        "multipart-upload",
        JSON.stringify({ ...uploadState, completedParts })
      );

      const percent = Math.round((completedCount / totalParts) * 100);
      setProgress(percent);
      setStatus(`Uploaded ${completedCount} / ${totalParts} parts (${percent}%)`);
    }

    // All parts done → Complete the upload
    setStatus("Completing upload...");
    await axios.post(`${API_BASE}/complete`, {
      upload_id,
      key,
      parts: Object.entries(completedParts).map(([num, etag]) => ({
        PartNumber: Number(num),
        ETag: etag,
      })),
    });

    localStorage.removeItem("multipart-upload");
    setStatus("✅ Upload completed successfully!");
    setIsUploading(false);
    setProgress(100);

    // Generate download link
    const downloadRes = await axios.post(`${API_BASE}/presign-download`, { key });
    setDownloadUrl(downloadRes.data.download_url);

    fetchFiles();
  } catch (err) {
    // This runs when user clicks Cancel (AbortError) or real error occurs
    if (axios.isCancel(err) || err.name === "CanceledError" || err.code === "ERR_CANCELED") {
      const saved = Object.keys(completedParts).length;
      setStatus(`Upload cancelled. ${saved} parts saved. You can resume later.`);
    } else {
      console.error(err);
      setStatus("Error: " + (err.response?.data?.detail || err.message));
    }
    setIsUploading(false);
  }
};

  const resumeUpload = async () => {
    const saved = localStorage.getItem("multipart-upload");
    if (!saved) return alert("No previous upload found");
    if (!file) return alert("Please select the same file again to resume");

    const uploadState = JSON.parse(saved);
    setIsUploading(true);
    setStatus("Resuming upload...");
    abortController.current = new AbortController();

    try {
      await uploadParts(file, uploadState);
    } catch (err) {
      setStatus("Error while resuming: " + err.message);
      setIsUploading(false);
    }
  };

  const cancelUpload = () => {
    if (abortController.current) abortController.current.abort();
  };

  const downloadFile = async (key) => {
    try {
      const res = await axios.post(`${API_BASE}/presign-download`, { key });
      window.open(res.data.download_url, "_blank");
    } catch (err) {
      alert("Failed to generate download link");
    }
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  };

  return (
    <div className="container">
      <h1>S3 Resumable Multipart Upload</h1>
      <p>Direct-to-S3 • Parallel parts • Browser progress saving</p>

      <input type="file" onChange={handleFileChange} disabled={isUploading} />

      {file && (
        <div className="file-info">
          <p>
            <strong>{file.name}</strong> ({(file.size / 1024 / 1024).toFixed(2)} MB)
          </p>
        </div>
      )}

      <div className="buttons">
        <button onClick={startUpload} disabled={!file || isUploading}>
          Start Upload
        </button>
        <button onClick={resumeUpload} disabled={isUploading}>
          Resume Previous
        </button>
        {isUploading && (
          <button onClick={cancelUpload} className="cancel">
            Cancel
          </button>
        )}
      </div>

      {progress > 0 && (
        <div className="progress-bar">
          <div className="progress" style={{ width: `${progress}%` }}></div>
        </div>
      )}

      <p className="status">{status}</p>

      {downloadUrl && (
        <div className="download-box">
          <p>✅ File ready!</p>
          <a href={downloadUrl} target="_blank" rel="noreferrer">
            Download Uploaded File
          </a>
        </div>
      )}

      {/* File Listing */}
      <div className="file-list">
        <h2>Uploaded Files</h2>
        {files.length === 0 ? (
          <p>No files uploaded yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Filename</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.key}>
                  <td>{f.filename}</td>
                  <td>{formatSize(f.size)}</td>
                  <td>{new Date(f.last_modified).toLocaleString()}</td>
                  <td>
                    <button onClick={() => downloadFile(f.key)}>Download</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default App;