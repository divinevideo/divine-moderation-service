# ABOUTME: Interactive Dashboard Features - Implementation Guide
# ABOUTME: What needs to be added to make the dashboard actually useful

## Problem

The dashboard is currently **100% passive** - you can only view videos, you can't DO anything with them.

## Required Interactive Features

### 1. Quick Action Buttons on Each Video Card

Add these 4 buttons at the bottom of each video card:

```html
<div class="action-buttons">
  <button class="action-btn approve" onclick="quickAction('${sha256}', 'SAFE')">Approve</button>
  <button class="action-btn age-restrict" onclick="quickAction('${sha256}', 'AGE_RESTRICTED')">Age-Restrict</button>
  <button class="action-btn ban" onclick="quickAction('${sha256}', 'PERMANENT_BAN')">Ban</button>
  <button class="action-btn edit" onclick="openEditModal('${sha256}')">Edit Scores</button>
</div>
```

**Location:** Add inside `.video-info` div, after the timestamp

### 2. JavaScript for Quick Actions

```javascript
// Quick action - change moderation action without modal
async function quickAction(sha256, action) {
  if (!confirm(`Are you sure you want to set this video to ${action}?`)) {
    return;
  }

  try {
    const response = await fetch(`/admin/api/moderate/${sha256}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason: `Quick action: ${action}` })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    console.log('Action updated:', result);

    // Reload videos to show updated data
    await loadVideos(paginationState.currentCursor);
    alert(`Successfully updated to ${action}`);
  } catch (error) {
    console.error('Failed to update action:', error);
    alert('Failed to update: ' + error.message);
  }
}
```

### 3. Modal for Editing Scores

Add this HTML before the closing `</body>` tag:

```html
<!-- Edit Scores Modal -->
<div class="modal" id="edit-modal">
  <div class="modal-content">
    <div class="modal-header">
      <h2>Edit Moderation Scores</h2>
      <button class="modal-close" onclick="closeEditModal()">&times;</button>
    </div>
    <div class="modal-body">
      <div id="edit-scores-container"></div>

      <div class="form-group">
        <label>Action</label>
        <select id="edit-action">
          <option value="SAFE">Safe</option>
          <option value="REVIEW">Review</option>
          <option value="AGE_RESTRICTED">Age-Restricted</option>
          <option value="PERMANENT_BAN">Permanent Ban</option>
        </select>
      </div>

      <div class="form-group">
        <label>Reason for Override</label>
        <textarea id="edit-reason" placeholder="Explain why you're overriding the AI classification..."></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeEditModal()">Cancel</button>
      <button class="btn-save" onclick="saveEdits()">Save Changes</button>
    </div>
  </div>
</div>
```

### 4. JavaScript for Modal

```javascript
let currentEditingSha256 = null;
let currentEditingVideo = null;

// Open modal to edit scores
function openEditModal(sha256) {
  const video = allVideos.find(v => v.sha256 === sha256);
  if (!video) return;

  currentEditingSha256 = sha256;
  currentEditingVideo = video;

  // Build score sliders
  const categories = ['nudity', 'violence', 'gore', 'offensive', 'weapon', 'self_harm',
                     'recreational_drug', 'alcohol', 'tobacco', 'ai_generated', 'deepfake',
                     'medical', 'gambling', 'money', 'destruction', 'military',
                     'text_profanity', 'qr_unsafe'];

  const slidersHTML = categories.map(cat => {
    const currentScore = video.scores[cat] || 0;
    const label = formatCategoryName(cat);
    return `
      <div class="score-slider">
        <label>${label}</label>
        <input type="range" id="edit-${cat}" min="0" max="100" value="${(currentScore * 100).toFixed(0)}"
               oninput="updateSliderValue('${cat}', this.value)">
        <span class="score-slider-value" id="value-${cat}">${(currentScore * 100).toFixed(0)}%</span>
      </div>
    `;
  }).join('');

  document.getElementById('edit-scores-container').innerHTML = slidersHTML;
  document.getElementById('edit-action').value = video.action;
  document.getElementById('edit-reason').value = video.manualOverride ? video.reason : '';

  // Show modal
  document.getElementById('edit-modal').classList.add('show');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.remove('show');
  currentEditingSha256 = null;
  currentEditingVideo = null;
}

function updateSliderValue(category, value) {
  document.getElementById(`value-${category}`).textContent = value + '%';
}

async function saveEdits() {
  if (!currentEditingSha256) return;

  // Get all slider values
  const categories = ['nudity', 'violence', 'gore', 'offensive', 'weapon', 'self_harm',
                     'recreational_drug', 'alcohol', 'tobacco', 'ai_generated', 'deepfake',
                     'medical', 'gambling', 'money', 'destruction', 'military',
                     'text_profanity', 'qr_unsafe'];

  const newScores = {};
  categories.forEach(cat => {
    const slider = document.getElementById(`edit-${cat}`);
    if (slider) {
      newScores[cat] = parseInt(slider.value) / 100;
    }
  });

  const action = document.getElementById('edit-action').value;
  const reason = document.getElementById('edit-reason').value || 'Manual score override by moderator';

  try {
    const response = await fetch(`/admin/api/moderate/${currentEditingSha256}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        reason,
        scores: newScores  // TODO: Add score override support to backend
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    console.log('Scores updated:', result);

    closeEditModal();
    await loadVideos(paginationState.currentCursor);
    alert('Successfully updated scores and action');
  } catch (error) {
    console.error('Failed to update:', error);
    alert('Failed to update: ' + error.message);
  }
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
  const modal = document.getElementById('edit-modal');
  if (e.target === modal) {
    closeEditModal();
  }
});
```

### 5. Show Manual Override Badge

Update the badge HTML to show when content has been manually overridden:

```html
<div class="video-overlay">
  <span class="badge ${actionClass}">${action}</span>
  ${video.manualOverride ? '<span class="override-badge">MANUAL</span>' : ''}
</div>
```

### 6. Backend: Add Score Override Support

The current `/admin/api/moderate/{sha256}` endpoint only accepts `action` and `reason`. We need to add support for overriding scores:

```javascript
// In src/index.mjs, update the moderate endpoint
const { action, reason, scores } = await request.json();

// If scores provided, override them
if (scores) {
  updated.scores = {
    ...existing.scores,
    ...scores
  };
}
```

## Implementation Priority

1. **HIGH**: Quick action buttons (Approve, Age-Restrict, Ban)
2. **HIGH**: Manual override badge
3. **MEDIUM**: Edit scores modal
4. **MEDIUM**: Backend score override support
5. **LOW**: Bulk selection checkboxes

## Expected User Flow

1. **Moderator sees video flagged as REVIEW**
2. **Clicks "Approve" button** → Video instantly set to SAFE
3. **OR clicks "Edit Scores"** → Modal opens
4. **Drags "AI-Generated" slider from 85% down to 10%** (false positive)
5. **Types reason**: "This is not AI-generated, it's just heavily edited"
6. **Clicks "Save Changes"** → Video updated with manual override badge
7. **Dashboard refreshes** → Video shows "MANUAL" badge

## Benefits

- **Fast triage**: Approve/ban videos with 1 click
- **Override AI mistakes**: Adjust individual scores
- **Audit trail**: Reasons logged for all manual overrides
- **Visual feedback**: See which videos have been manually reviewed

## CSS Already Added

All the CSS for these features has been added to the dashboard:
- `.action-buttons` - Button container
- `.action-btn` - Button styles with approve/age-restrict/ban/edit variants
- `.override-badge` - Purple badge for manual overrides
- `.modal` - Full modal system with header/body/footer
- `.score-slider` - Range sliders for editing scores
- `.form-group` - Form styling

## Next Steps

1. Add action buttons HTML to video cards
2. Add modal HTML before `</body>`
3. Add JavaScript functions for quick actions and modal
4. Test quick approve/ban workflow
5. Test edit scores modal workflow
6. Add backend score override support
7. Deploy and use in production
