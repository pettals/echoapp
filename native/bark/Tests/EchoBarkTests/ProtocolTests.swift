import XCTest
@testable import EchoBark

final class ProtocolTests: XCTestCase {
    func testCleanupRetainsWordingAndPunctuation() {
        XCTAssertEqual(cleanTranscript("  Hello <unk>world.\n"), "Hello world.")
        XCTAssertEqual(cleanTranscript("um, I mean this."), "um, I mean this.")
        XCTAssertEqual(cleanTranscript("<unk>"), "")
    }

    func testProtocolKeepsTranscriptsInOneJSONLine() throws {
        let result = Response(id: 7, kind: "result", text: "line one\nline two")
        let data = try JSONEncoder().encode(result)
        XCTAssertFalse(data.contains(10))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["id"] as? Int, 7)
        XCTAssertEqual(object["text"] as? String, "line one\nline two")
    }

    func testMalformedRequestsAreRejected() {
        XCTAssertThrowsError(try JSONDecoder().decode(Request.self, from: Data("{}".utf8)))
    }
}
