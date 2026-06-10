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
    const el = doc.querySelector(".page") || doc.body;
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false, windowWidth: 780 });
    const img = canvas.toDataURL("image/jpeg", 0.92);

    const pdf = new jsPDF({ unit: "mm", format: "a4" });
    const pageW = 210, pageH = 297;
    const imgH = (canvas.height * pageW) / canvas.width;
    // Repeat the full-height image with a negative offset per page — the
    // standard html2canvas pagination pattern.
    let heightLeft = imgH;
    pdf.addImage(img, "JPEG", 0, 0, pageW, imgH);
    heightLeft -= pageH;
    while (heightLeft > 0) {
      pdf.addPage();
      pdf.addImage(img, "JPEG", 0, heightLeft - imgH, pageW, imgH);
      heightLeft -= pageH;
    }
    return pdf.output("blob");
  } finally {
    iframe.remove();
  }
}
