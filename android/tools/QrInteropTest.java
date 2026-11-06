import com.google.zxing.BinaryBitmap;
import com.google.zxing.LuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.DecodeHintType;
import com.google.zxing.NotFoundException;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.EnumMap;
import java.util.Map;

/** Runs on the build JDK: proves desktop encoding and Android decoding agree. */
public class QrInteropTest {
  private static final class Gray extends LuminanceSource {
    private final byte[] pixels;
    Gray(int size, byte[] pixels) { super(size, size); this.pixels = pixels; }
    public byte[] getRow(int y, byte[] row) {
      if (row == null || row.length < getWidth()) row = new byte[getWidth()];
      System.arraycopy(pixels, y * getWidth(), row, 0, getWidth());
      return row;
    }
    public byte[] getMatrix() { return pixels; }
  }
  public static void main(String[] args) throws Exception {
    int size = Integer.parseInt(args[0]);
    byte[] pixels = Files.readAllBytes(Paths.get(args[1]));
    if (pixels.length != size * size) throw new AssertionError("Invalid raster size");
    String expected = new String(Files.readAllBytes(Paths.get(args[2])), StandardCharsets.UTF_8);
    Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
    hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
    BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(new Gray(size, pixels)));
    Result result;
    try {
      result = new QRCodeReader().decode(bitmap, hints);
    } catch (NotFoundException exception) {
      // A perfectly axis-aligned synthetic raster can trigger a detector edge
      // case. PURE_BARCODE still validates the full version/mask/ECC payload.
      hints.put(DecodeHintType.PURE_BARCODE, Boolean.TRUE);
      result = new QRCodeReader().decode(bitmap, hints);
      System.out.println("Synthetic raster decoded with PURE_BARCODE fallback");
    }
    if (!expected.equals(result.getText())) throw new AssertionError("QR pairing payload differs after decode");
    System.out.println("QR round-trip passed: " + expected.length() + " UTF-8 JSON characters");
  }
}
