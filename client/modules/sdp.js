// Inject Opus music-optimized parameters into SDP.
// Without this, Opus defaults to VOIP mode (high-pass filter ~80Hz, mono, low target bitrate).
export function mungeOpusSdp(sdp) {
  const opusPTs = new Set();
  const re = /a=rtpmap:(\d+) opus\//gi;
  let m;
  while ((m = re.exec(sdp)) !== null) {
    opusPTs.add(m[1]);
  }
  if (opusPTs.size === 0) return sdp;

  return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (match, pt, params) => {
    if (!opusPTs.has(pt)) return match;

    const paramMap = {};
    for (const p of params.split(';')) {
      const pTrim = p.trim();
      if (!pTrim) continue;
      const eqIdx = pTrim.indexOf('=');
      if (eqIdx >= 0) {
        paramMap[pTrim.substring(0, eqIdx).trim()] = pTrim.substring(eqIdx + 1).trim();
      } else {
        paramMap[pTrim] = '';
      }
    }

    // Music-optimized Opus: stereo, higher target bitrate, no DTX.
    paramMap['stereo'] = '1';
    paramMap['sprop-stereo'] = '1';
    paramMap['maxaveragebitrate'] = '256000';
    paramMap['usedtx'] = '0';
    // FEC embeds a low-bitrate copy of the previous frame in each packet.
    paramMap['useinbandfec'] = '1';
    paramMap['minptime'] = '10';

    const newParams = Object.entries(paramMap)
      .map(([k, v]) => v !== '' ? `${k}=${v}` : k)
      .join(';');

    return `a=fmtp:${pt} ${newParams}`;
  });
}
