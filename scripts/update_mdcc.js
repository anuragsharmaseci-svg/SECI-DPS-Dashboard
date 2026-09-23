const fs = require('fs');
let file = fs.readFileSync('E:/seci-dps-dashboard/seci-dps-dashboard/public/mdcc_form.html', 'utf8');
// 1. Change header image size
file = file.replace(
  `.header-img-container img {
      width: 100%;
      height: auto;
      display: block;
    }`,
  `.header-img-container img {
      width: 100%;
      max-height: 95px;
      object-fit: contain;
      display: block;
    }`
);
// 2. Add signature name print CSS rule to hide border/dashes
file = file.replace(
  `      input, textarea {
        border: none !important;
        outline: none !important;
        background: transparent !important;
      }`,
  `      input, textarea {
  border: none !important;
        outline: none !important;
        background: transparent !important;
      }
      #f_signature_name {
        border: none !important;
        border-bottom: none !important;
      }
      #f_signature_name::placeholder {
        color: transparent !important;
      }
      #f_signature_name:-ms-input-placeholder {
        color: transparent !important;
      }
      #f_signature_name::-ms-input-placeholder {
        color: transparent !important;
      }`
);
// 3. Add styles for dynamic points (bold italic, no numbering, same size)
file = file.replace(
  `    textarea {
      resize: vertical;
      min-height: 40px;
    }`,
  `    textarea {
      resize: vertical;
      min-height: 40px;
    }
    #dynamic-points-list {
      margin-top: 5px;
      padding-left: 0;
      list-style: none;
    }
    #dynamic-points-list li {
      font-size: 11px;
      font-weight: bold;
      font-style: italic;
      margin-bottom: 2px;
      line-height: 1.5;
    }
    #f_to_address {
      font-weight: bold;
      font-style: italic;
      font-size: 11px;
      line-height: 1.4;
      height: 115px !important;
      resize: none;
      overflow: hidden;
      margin-top: 5px;
      padding: 0;
    }`
);
    
// 4. Update dynamic points markup from ol to ul
file = file.replace(
  `<ol id="dynamic-points-list" style="margin-top: 5px; padding-left: 15px;"></ol>`,
  `<ul id="dynamic-points-list"></ul>`
);
// 5. Update signature name input markup (area before footer image)
file = file.replace(
  `      <div style="margin-top: 10px; font-size: 11px;">
        <div style="text-align: right; font-weight: bold; margin-bottom: 30px;">
          For and on behalf of SOLAR ENERGY CORPORATION OF INDIA LTD.
        </div>
        <!-- Space for stamp -->
        <div style="height: 35px;"></div>
      </div>`,
  `      <div style="margin-top: 10px; font-size: 11px; position: relative;">
        <div style="text-align: right; font-weight: bold; margin-bottom: 5px;">
          For and on behalf of SOLAR ENERGY CORPORATION OF INDIA LTD.
                  <div style="text-align: right; margin-top: 5px; margin-bottom: 5px;">
          <input type="text" id="f_signature_name" placeholder="-----------------------------" style="text-align: right; font-weight: bold; font-size: 11px; width: 250px; border-bottom: 1px dashed #888; display: inline-block; padding: 0 4px;" />
        </div>
      </div>`
);
// 6. Prepend # prefix automatically on dynamic points
file = file.replace(
  `    function addPointToList(val) {
      const li = $('<li></li>').text(val);`,
  `    function addPointToList(val) {
      const prefix = (val.startsWith('#') || val.startsWith('*')) ? '' : '# ';
      const li = $('<li></li>').text(prefix + val);`
);
// 7. Save and retrieve f_signature_name via remarks split
file = file.replace(
  `              // Parse remarks to retrieve Inspection Report and Additional Points
              const dbRemarks = mdcc.remarks || '';
              if (dbRemarks.includes('---CONDITIONS---')) {
                const parts = dbRemarks.split('---CONDITIONS---');
                $('#f_inspection_report').val(parts[0].trim());
              try {
                  const pts = JSON.parse(parts[1].trim());
                  if (Array.isArray(pts)) {
                    pts.forEach(p => addPointToList(p));
                  }
                } catch(e) {
                  // Fallback if not JSON
                  parts[1].split('\\n').forEach(p => {
                    if (p.trim()) addPointToList(p.trim());
                  });
                }
              } else {
                $('#f_inspection_report').val(dbRemarks);
              }`,
  `              // Parse remarks to retrieve Inspection Report, Signature Name, and Additional Points
              const dbRemarks = mdcc.remarks || '';
              let inspectionText = dbRemarks;
              let sigName = '';
              let conditionsJson = '';
              if (dbRemarks.includes('---SIGNAME---')) {
                const sigParts = dbRemarks.split('---SIGNAME---');
                inspectionText = sigParts[0].trim();
                const restParts = sigParts[1].split('---CONDITIONS---');
                sigName = restParts[0].trim();
                conditionsJson = restParts[1] ? restParts[1].trim() : '';
              } else if (dbRemarks.includes('---CONDITIONS---')) {
                const parts = dbRemarks.split('---CONDITIONS---');
                inspectionText = parts[0].trim();
                conditionsJson = parts[1].trim();
              }
              $('#f_inspection_report').val(inspectionText);
              $('#f_signature_name').val(sigName);
              if (conditionsJson) {
                try {
                  const pts = JSON.parse(conditionsJson);
                  if (Array.isArray(pts)) {
                    pts.forEach(p => addPointToList(p));
                  }
                } catch(e) {
                  conditionsJson.split('\\n').forEach(p => {
                    if (p.trim()) addPointToList(p.trim());
                  });
                }
              }`
);
// 8. Update combinedRemarks format to include f_signature_name
file = file.replace(
  `      // Combine inspection report and conditions into remarks field
      const inspectionReport = $('#f_inspection_report').val().trim();
      let combinedRemarks = inspectionReport;
      if (additionalPoints.length > 0) {
        combinedRemarks += '\\n---CONDITIONS---\\n' + JSON.stringify(additionalPoints);
      }`,
  `      // Combine inspection report, signature name, and conditions into remarks field
      const inspectionReport = $('#f_inspection_report').val().trim();
      const sigName = $('#f_signature_name').val().trim();
      let combinedRemarks = inspectionReport;
      if (sigName || additionalPoints.length > 0) {
        combinedRemarks += '\\n---SIGNAME---\\n' + sigName + '\\n---CONDITIONS---\\n' + JSON.stringify(additionalPoints);
      }`
);
fs.writeFileSync('E:/seci-dps-dashboard/seci-dps-dashboard/public/mdcc_form.html', file);
console.log('done modifying mdcc_form.html');
