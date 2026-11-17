// Worker-only: files too large for one request (Cloudflare's 100 MB body cap,
// and a 128 MB Worker) are uploaded to R2 in parts, then the post form is sent
// with those media ids instead of the files. Appended by scripts/build-ui.mjs.
const apiUploadDirect = apiUpload;
const CHUNKED_UPLOAD_THRESHOLD = 24 * 1024 * 1024;

function xhrRequest(method, url, body, token, onUploadProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('x-csrf-token', token);
    if (onUploadProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onUploadProgress(event.loaded);
      });
    }
    xhr.addEventListener('load', () => {
      if (xhr.status === 401) {
        window.location.href = '/login';
        reject(new Error('not authenticated'));
        return;
      }
      let data = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        // non-JSON body
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(extractErrorMessageFromData(data)));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed. Check your connection and try again.')));
    xhr.send(body);
  });
}

async function jsonWithCsrf(method, url, token, body) {
  const response = await fetch(url, {
    method,
    headers: {
      'x-csrf-token': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    window.location.href = '/login';
    throw new Error('not authenticated');
  }
  let data = null;
  if (response.status !== 204) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }
  if (!response.ok) throw new Error(extractErrorMessageFromData(data));
  return data;
}

async function uploadMediaInChunks(formData, files, onProgress) {
  const token = await getCsrfToken();
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let uploaded = 0;
  const report = (loadedInCurrent) => {
    if (onProgress) onProgress(Math.min(99, Math.round(((uploaded + loadedInCurrent) / total) * 90)));
  };
  const ids = [];
  for (const file of files) {
    const created = await jsonWithCsrf('POST', '/api/v1/media/uploads', token, {
      content_type: file.type || 'application/octet-stream',
      size: file.size,
    });
    const partSize = created.part_size;
    try {
      for (let number = 1; number <= created.part_count; number += 1) {
        const start = (number - 1) * partSize;
        const slice = file.slice(start, Math.min(start + partSize, file.size));
        await xhrRequest('PUT', `/api/v1/media/uploads/${created.id}/parts/${number}`, slice, token, (loaded) => report(loaded));
        uploaded += slice.size;
        report(0);
      }
      const done = await jsonWithCsrf('POST', `/api/v1/media/uploads/${created.id}/complete`, token);
      ids.push(done.id);
    } catch (error) {
      await jsonWithCsrf('DELETE', `/api/v1/media/uploads/${created.id}`, token).catch(() => undefined);
      throw error instanceof Error ? error : new Error('Upload failed.');
    }
  }
  formData.delete('media');
  ids.forEach((id) => formData.append('media_ids', String(id)));
  return apiUploadDirect('/api/v1/posts', formData, (percent) => {
    if (onProgress) onProgress(Math.min(100, 90 + Math.round(percent / 10)));
  });
}

apiUpload = function apiUpload(path, formData, onProgress) {
  const files = path === '/api/v1/posts' && formData
    ? formData.getAll('media').filter((value) => value instanceof File)
    : [];
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (path !== '/api/v1/posts' || total <= CHUNKED_UPLOAD_THRESHOLD) {
    return apiUploadDirect(path, formData, onProgress);
  }
  return uploadMediaInChunks(formData, files, onProgress);
};
