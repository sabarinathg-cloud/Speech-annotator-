import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioWaveformPlayer } from "@/components/audio-waveform-player";

afterEach(() => cleanup());

describe("AudioWaveformPlayer", () => {
  it("labels the preview as an amplitude-time waveform", () => {
    render(<AudioWaveformPlayer audioUrl="/audio/test.mp3" />);

    expect(screen.getByRole("img", { name: "Amplitude-time waveform" })).toBeInTheDocument();
    expect(screen.getByText("Amplitude")).toBeInTheDocument();
    expect(screen.getByText("Time (s)")).toBeInTheDocument();
  });

  it("seeks only for unmodified seek shortcuts", () => {
    const { container } = render(<AudioWaveformPlayer audioUrl="/audio/test.mp3" />);
    const audio = container.querySelector("audio") as HTMLAudioElement;

    audio.currentTime = 10;
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    expect(audio.currentTime).toBe(10);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(audio.currentTime).toBe(15);
  });

  it("lets users change playback speed", () => {
    const { container } = render(<AudioWaveformPlayer audioUrl="/audio/test.mp3" />);
    const audio = container.querySelector("audio") as HTMLAudioElement;

    fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "1.5" } });
    expect(audio.playbackRate).toBe(1.5);

    fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "0.75" } });
    expect(audio.playbackRate).toBe(0.75);
  });

  it("removes browser download controls from the audio player", () => {
    const { container } = render(<AudioWaveformPlayer audioUrl="/audio/test.mp3" />);
    const audio = container.querySelector("audio") as HTMLAudioElement;

    expect(audio).toHaveAttribute("controlsList", expect.stringContaining("nodownload"));
    expect(fireEvent.contextMenu(audio)).toBe(false);
  });

  it("allows browser download controls when requested", () => {
    const { container } = render(<AudioWaveformPlayer audioUrl="/audio/test.mp3" allowDownloadControls />);
    const audio = container.querySelector("audio") as HTMLAudioElement;

    expect(audio).not.toHaveAttribute("controlsList");
    expect(fireEvent.contextMenu(audio)).toBe(true);
  });

  it("zooms the waveform timeline in and out", () => {
    render(<AudioWaveformPlayer audioUrl="/audio/test.mp3" />);
    const seekArea = screen.getByRole("button", { name: "Waveform seek area" });

    expect(seekArea).toHaveStyle({ width: "100%" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in waveform" }));
    expect(seekArea).toHaveStyle({ width: "125%" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom out waveform" }));
    expect(seekArea).toHaveStyle({ width: "100%" });
  });

  it("highlights PII intervals and lets users adjust mask handles", () => {
    const onIntervalsChange = vi.fn();
    render(
      <AudioWaveformPlayer
        audioUrl="/audio/test.mp3"
        highlightIntervals={[{ start_seconds: 0.2, end_seconds: 0.5, labels: ["PHONE"], text: "1234567890" }]}
        editableIntervals
        onIntervalsChange={onIntervalsChange}
      />
    );

    expect(screen.getByText("PHONE")).toBeInTheDocument();

    const startHandle = screen.getByRole("button", { name: /PII start handle for PHONE/i });
    const endHandle = screen.getByRole("button", { name: /PII end handle for PHONE/i });
    expect(startHandle).toBeInTheDocument();
    expect(endHandle).toBeInTheDocument();

    fireEvent.keyDown(startHandle, { key: "ArrowLeft" });
    expect(onIntervalsChange).toHaveBeenCalledWith([
      { start_seconds: 0.1, end_seconds: 0.5, labels: ["PHONE"], text: "1234567890" },
    ]);
  });
});
