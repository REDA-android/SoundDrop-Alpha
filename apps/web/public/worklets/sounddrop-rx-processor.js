class SoundDropRxProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channel = input[0];
      if (channel && channel.length > 0) {
        // Copy buffer before transferring to main thread
        const copy = new Float32Array(channel);
        this.port.postMessage(copy, [copy.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("sounddrop-rx-processor", SoundDropRxProcessor);
