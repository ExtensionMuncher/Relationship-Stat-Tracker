# Relationship Stat Tracker (RST)

A SillyTavern extension that tracks relationship stats between characters across roleplay sessions. RST uses a lightweight sidecar LLM to detect which characters are present in your chat, and a main LLM to review closed scenes and generate nuanced stat updates — all without interrupting your primary AI or burning unnecessary tokens.

---

# Planned Updates

## Critical Increase/Decreases

Whenever a significant moment occurs within the roleplay scene, the respective stat(s) will increase/decrease thrice the amount set within the "Stat Change Range."

These moments, like the amounts themselves, are RNG-based.

## Thresholds Locks

### Hard Locks

This allows the AI to set caps on an NPC's stats based on their personality, psychology, and history. If an NPC is heavily traumatized and not the trusting sort, there may be hard limits set on their Trust stats to remain true to the NPC's psychology.

### Soft Locks (Unlockable)

This is a softer cap that may require the {{user}} to perform certain actions or meet certain thresholds to continue relationship growth with the respective NPC. Stat growth will not be allowed in the locked stat until these thresholds are met.
