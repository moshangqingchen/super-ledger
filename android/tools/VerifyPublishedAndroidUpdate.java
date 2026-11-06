import com.moneylab.superledger.mobile.UpdatePolicy;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.PublicKey;
import org.json.JSONObject;

/** Verifies the real release envelope with the public key shipped in the APK. */
public final class VerifyPublishedAndroidUpdate {
  public static void main(String[] args) throws Exception {
    byte[] envelope = Files.readAllBytes(Paths.get(args[0]));
    PublicKey key = UpdatePolicy.publicKey(Files.readAllBytes(Paths.get(args[1])));
    UpdatePolicy.Release release = UpdatePolicy.verify(envelope, key, 0, 35);
    if (release == null) throw new AssertionError("Release manifest did not contain a positive Android version");
    UpdatePolicy.verifyFile(new File(args[2]), release);
    if (UpdatePolicy.verify(envelope, key, release.versionCode, 35) != null) throw new AssertionError("Installed same version was offered again");
    JSONObject altered = new JSONObject(new String(envelope, java.nio.charset.StandardCharsets.UTF_8));
    byte[] signature = java.util.Base64.getDecoder().decode(altered.getString("signature"));
    signature[0] ^= 1;
    altered.put("signature", java.util.Base64.getEncoder().encodeToString(signature));
    boolean rejected = false;
    try { UpdatePolicy.verify(altered.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8), key, 0, 35); }
    catch (Exception expected) { rejected = true; }
    if (!rejected) throw new AssertionError("Tampered production envelope signature accepted");
    System.out.println("Production update manifest verified by Android Java policy: version=" + release.version + ", code=" + release.versionCode + ", bytes=" + release.size);
    System.out.println("Public-key signature, APK SHA-256, exact size, same-version suppression and tamper rejection passed; no network request or installation performed.");
  }
}
