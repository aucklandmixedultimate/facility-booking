// Faithful HTML→PDF rendering for billing documents.
//
// Renders the exact invoice/PO HTML the app already produces in a hidden
// same-origin iframe, rasterises it with html2canvas, and lays the image onto
// A4 pages with jsPDF. Both libraries are loaded lazily so the ~main bundle
// doesn't grow for users who never touch Drive export.

export async function htmlToPdfBlob(html) {
  const [{ jsPDF }, html2canvasMod] = await Promise.all([import("jspdf"), import("html2canvas")]);
  const html2canvas = html2canvasMod.default || html2canvasMod;

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:780px;height:1400px;border:0;visibility:hidden;";
  document.body.appendChild(iframe);
  try {
    await new Promise((resolve) => { iframe.onload = resolve; iframe.srcdoc = html; });
    await new Promise((r) => setTimeout(r, 200)); // let fonts/layout settle
    const doc = iframe.contentDocument;
    // Documents lay their line items out in `.sheet` blocks, each already sized to one
    // A4 page and carrying a subtotal for its own rows. Rasterise each sheet onto its own
    // PDF page so those boundaries are honoured — slicing one tall image by height would
    // cut wherever the image happened to reach 297mm, stranding a sheet's subtotal on the
    // following page. Falls back to the whole document for anything without sheets.
    const sheets = [...doc.querySelectorAll(".sheet")];
    const targets = sheets.length ? sheets : [doc.querySelector(".page") || doc.body];

    const pdf = new jsPDF({ unit: "mm", format: "a4" });
    const pageW = 210, pageH = 297;
    for (let i = 0; i < targets.length; i++) {
      const canvas = await html2canvas(targets[i], { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false, windowWidth: 780 });
      const img = canvas.toDataURL("image/jpeg", 0.92);
      const imgH = (canvas.height * pageW) / canvas.width;
      if (i > 0) pdf.addPage();
      pdf.addImage(img, "JPEG", 0, 0, pageW, imgH);
      // A sheet taller than a page still gets sliced rather than clipped — belt and
      // braces, since the row budget is meant to keep every sheet inside one page.
      let heightLeft = imgH - pageH;
      while (heightLeft > 0) {
        pdf.addPage();
        pdf.addImage(img, "JPEG", 0, heightLeft - imgH, pageW, imgH);
        heightLeft -= pageH;
      }
    }
    return pdf.output("blob");
  } finally {
    iframe.remove();
  }
}
